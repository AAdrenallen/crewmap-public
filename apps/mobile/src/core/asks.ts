import { openJson, peerSupports, type DeviceIdentity, type Incoming } from '@crewmap/p2p';
import {
  ASK,
  askGate,
  dismissAsk,
  expireAsks,
  minutesLeft,
  newAsk,
  parseAskOp,
  receiveAsk,
  resolveIncoming,
  shareOp,
  type AskEntry,
  type AskKind,
  type AskOp,
  type AskPlace,
} from '@crewmap/shared/companions';
import { t } from '@crewmap/shared/i18n';
import { useAsks } from './asksStore';
import type { Crews } from './crews';
import { kvGet, kvSet } from './db';
import { friendContextNow } from './friendContext';
import { isAskMuted, loadMuted, setAskMuted } from './friendPrefs';
import { notify } from './notify';
import { useApp } from './store';
import { notifyMode } from '../ui/drive/driveUx';

const KEY = 'asks.v1';
const TICK_MS = 20_000;

export type AskAvailability = 'ok' | 'offline' | 'old' | 'pending' | 'cooldown';

/**
 * Location asks (D47): "Ask location" = where do you want me? ('where'), and "Ask to share once" for crewmates whose
 * policy shows me nothing ('once'). One wire kind, 'where-ask', box-sealed to the one recipient. A one-time share is
 * an answer to an explicit request, so it deliberately bypasses the standing crew policy for that request only; it
 * expires on both sides and the received position is wiped at expiry.
 */
export class Asks {
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly crews: Crews,
    private readonly me: DeviceIdentity,
  ) {}

  start(): void {
    const r = this.crews.router;
    if (!r || this.offs.length) return;
    this.offs.push(r.on('where-ask', (m) => void this.onMessage(m)));
    void loadMuted().catch(() => undefined);
    void kvGet<AskEntry[]>(KEY, []).then((saved) => {
      // Entries received while loading win; saved ones are expired first, so no stale position comes back.
      const have = new Set(useAsks.getState().entries.map((e) => e.id));
      this.set([...expireAsks(saved, Date.now()).filter((e) => !have.has(e.id)), ...useAsks.getState().entries]);
    });
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    for (const o of this.offs) o();
    this.offs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Expire stale entries; refresh the friend map when a one-time share ended. */
  tick(): void {
    const cur = useAsks.getState().entries;
    const next = expireAsks(cur, Date.now());
    if (next.length === cur.length && next.every((e, i) => e === cur[i])) return;
    this.set(next, cur.some((e) => e.dir === 'out' && e.state === 'shared'));
  }

  private set(entries: AskEntry[], refresh = true): void {
    useAsks.setState({ entries });
    void kvSet(KEY, entries).catch(() => undefined);
    if (refresh) this.crews.refreshFriends();
  }

  // --- availability ----------------------------------------------------------------------------------------------

  /**
   * Whether I can ask `friendId` now. A friend who hides their location sends no presence, so their build is unknown
   * and is tried; a known older build is "needs update".
   */
  availability(friendId: string, kind: AskKind): AskAvailability {
    if (!this.crews.router) return 'offline';
    if (peerSupports(useApp.getState().allFriends[friendId]?.presence, 'askWhere') === false) return 'old';
    return askGate(useAsks.getState().entries, 'out', friendId, kind, Date.now());
  }

  // --- asking ----------------------------------------------------------------------------------------------------

  async ask(friendId: string, kind: AskKind): Promise<AskAvailability> {
    const a = this.availability(friendId, kind);
    if (a !== 'ok') return a;
    const now = Date.now();
    const id = `ask-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const r = newAsk(useAsks.getState().entries, friendId, kind, id, now);
    if (r.gate !== 'ok') return r.gate;
    if (!(await this.send(friendId, { v: 1, op: 'ask', id, ask: kind, t: now }))) return 'offline';
    this.set(r.entries, false);
    return 'ok';
  }

  private send(to: string, op: AskOp): Promise<boolean> {
    return this.crews.companionSend(to, 'where-ask', () => op);
  }

  // --- answering -------------------------------------------------------------------------------------------------

  private pendingIn(id: string): AskEntry | undefined {
    return useAsks.getState().entries.find((e) => e.id === id && e.dir === 'in' && e.state === 'pending');
  }

  /** Answer a "where do you want me?" with a place and an optional short note. */
  async answerWhere(id: string, place: AskPlace, note = ''): Promise<boolean> {
    const e = this.pendingIn(id);
    if (!e || e.ask !== 'where') return false;
    const n = note.trim().slice(0, ASK.noteMax);
    if (!(await this.send(e.peer, { v: 1, op: 'answer', id, place, ...(n ? { note: n } : {}), t: Date.now() }))) return false;
    this.set(resolveIncoming(useAsks.getState().entries, id, 'answered', { place }), false);
    return true;
  }

  /** Share my current precise position once, for `minutes`, with just the requester. */
  async shareOnce(id: string, minutes: number): Promise<'ok' | 'noFix' | 'failed'> {
    const e = this.pendingIn(id);
    const fix = useApp.getState().fix;
    if (!e || e.ask !== 'once') return 'failed';
    if (!fix) return 'noFix';
    const op = shareOp(id, { lat: fix.lat, lng: fix.lng, acc: fix.accuracy }, minutes, Date.now());
    if (!(await this.send(e.peer, op))) return 'failed';
    this.set(resolveIncoming(useAsks.getState().entries, id, 'shared', { until: op.until }), false);
    return 'ok';
  }

  async decline(id: string, mute = false): Promise<void> {
    const e = this.pendingIn(id);
    if (!e) return;
    this.set(resolveIncoming(useAsks.getState().entries, id, 'declined'), false);
    if (mute) await setAskMuted(e.peer, true);
    await this.send(e.peer, { v: 1, op: 'decline', id, t: Date.now() });
  }

  /** Remove a destination card (Dismiss, or after Navigate). */
  dismiss(id: string): void {
    this.set(dismissAsk(useAsks.getState().entries, id), false);
  }

  // --- receiving -------------------------------------------------------------------------------------------------

  private async onMessage(m: Incoming): Promise<void> {
    const op = parseAskOp(openJson(this.me, m.payload));
    if (!op) return;
    const now = Date.now();
    const res = receiveAsk(useAsks.getState().entries, m.sender, op, now, isAskMuted(m.sender));
    if (res.effect === 'ignored') return;
    this.set(res.entries, res.effect === 'shared');
    const name = useApp.getState().allFriends[m.sender]?.profile.name ?? '';
    if (!name) return;
    const e = res.entries.find((x) => x.id === op.id);
    const title =
      res.effect === 'prompt'
        ? t(e?.ask === 'once' ? 'ask.promptOnce' : 'ask.promptWhere', { name })
        : res.effect === 'destination'
          ? t('ask.wantsYou', { name, place: e?.place?.name ?? '' })
          : res.effect === 'shared'
            ? t('ask.sharedNotice', { name, min: minutesLeft(e?.until ?? 0, now) })
            : t('ask.declined', { name });
    const { ctx, next } = friendContextNow();
    const mode = notifyMode('ask', ctx, next);
    if (mode === 'skip') return;
    void notify(title, '', { channel: 'circle', silent: mode === 'silent', data: { type: 'friendAlert', friendId: m.sender } });
  }
}
