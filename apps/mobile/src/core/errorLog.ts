import { File, Paths } from 'expo-file-system';
import { Logger } from '@rnmapbox/maps';
import { create } from 'zustand';
import { makeEntry, pushEntry, type ErrorEntry, type ErrorKind } from './errorScrub';
import { useApp } from './store';

/**
 * Rotating on-device error log (last MAX_ENTRIES), privacy-scrubbed: render errors, global JS errors, unhandled
 * promise rejections, Mapbox native logs, and console.error/warn in __DEV__. Shown in Settings → Help → Diagnostics;
 * `crewmap://dev/errors?action=dump` prints it to logcat (tag ReactNativeJS, prefix DUMP_TAG) for tools/device.
 */
export const DUMP_TAG = 'CMERRLOG';
const FILE_NAME = 'crewmap-errors.json';

export const useErrorLog = create<{ entries: ErrorEntry[] }>(() => ({ entries: [] }));

let route = 'index';
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let recording = false;

export function setErrorRoute(r: string): void {
  route = r;
}

function file(): File {
  return new File(Paths.document, FILE_NAME);
}

function names(): string[] {
  try {
    const s = useApp.getState();
    const out: string[] = [];
    const me = (s as { me?: { name?: string } | null }).me;
    if (me?.name) out.push(me.name);
    for (const f of Object.values(s.allFriends ?? {})) if (f?.profile?.name) out.push(f.profile.name);
    return out;
  } catch {
    return [];
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const f = file();
    if (!f.exists) return;
    const prev = JSON.parse(f.textSync()) as ErrorEntry[];
    if (Array.isArray(prev)) useErrorLog.setState((s) => ({ entries: [...prev, ...s.entries].slice(-200) }));
  } catch {
    // Unreadable log: start fresh.
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      file().write(JSON.stringify(useErrorLog.getState().entries));
    } catch {
      // Storage unavailable: the in-memory log still works.
    }
  }, 1000);
}

export function recordError(kind: ErrorKind, e: unknown): void {
  if (recording) return;
  recording = true;
  try {
    load();
    const entry = makeEntry(kind, e, route, names());
    useErrorLog.setState((s) => ({ entries: pushEntry(s.entries, entry) }));
    scheduleSave();
  } catch {
    // Never throw from the error path.
  } finally {
    recording = false;
  }
}

export function clearErrors(): void {
  useErrorLog.setState({ entries: [] });
  try {
    const f = file();
    if (f.exists) f.delete();
  } catch {
    // Nothing to delete.
  }
}

export function errorsText(): string {
  load();
  return useErrorLog
    .getState()
    .entries.map((e) => `${new Date(e.t).toISOString()} [${e.kind}] (${e.route ?? '-'}) ${e.msg}${e.stack ? `\n  ${e.stack.replace(/\n/g, '\n  ')}` : ''}`)
    .join('\n');
}

/** One logcat line per entry, then a count line, so collect-errors.sh can grep them. */
export function dumpErrors(): void {
  load();
  const list = useErrorLog.getState().entries;
  for (const e of list) console.log(`${DUMP_TAG} ${JSON.stringify(e)}`);
  console.log(`${DUMP_TAG} count=${list.length}`);
}

interface ErrorUtilsLike {
  getGlobalHandler(): (e: unknown, isFatal?: boolean) => void;
  setGlobalHandler(h: (e: unknown, isFatal?: boolean) => void): void;
}
interface HermesLike {
  enablePromiseRejectionTracker?: (o: { allRejections: boolean; onUnhandled: (id: number, e: unknown) => void; onHandled: (id: number) => void }) => void;
}

let installed = false;

/** Installs every capture hook once (call at module load of the root layout). */
export function installErrorCapture(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as { ErrorUtils?: ErrorUtilsLike; HermesInternal?: HermesLike };

  const eu = g.ErrorUtils;
  if (eu) {
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((e, isFatal) => {
      recordError(isFatal ? 'fatal' : 'js', e);
      prev(e, isFatal);
    });
  }

  const hermes = g.HermesInternal;
  if (hermes?.enablePromiseRejectionTracker) {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, e) => {
        recordError('promise', e);
        if (__DEV__) console.warn('Unhandled promise rejection', e);
      },
      onHandled: () => undefined,
    });
  }

  if (__DEV__) {
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...args: unknown[]) => {
      recordError('console.error', args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
      origError(...args);
    };
    console.warn = (...args: unknown[]) => {
      recordError('console.warn', args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
      origWarn(...args);
    };
  }

  try {
    Logger.setLogCallback((log) => {
      if (log.level === 'error' || log.level === 'warning') recordError('mapbox', `${log.level} ${log.tag}: ${log.message}`);
      return false;
    });
  } catch {
    // Native logger unavailable (tests): nothing to hook.
  }
}

/** For every `<Images onImageMissing>`: a layer references an image that was never registered. */
export const onMapboxImageMissing = (key: string): void => recordError('mapbox', `image missing "${key}"`);

/** For every `<MapView onMapLoadingError>`: style, sprite, source, glyph or tile load failure. */
export const onMapboxLoadingError = (p?: { error?: string; type?: string; sourceId?: string }): void =>
  recordError('mapbox', `load error ${p?.type ?? '-'} ${p?.sourceId ? `source "${p.sourceId}" ` : ''}${p?.error ?? ''}`);
