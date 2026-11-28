import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { platform } from '@crewmap/platform';
import {
  IMAGE_MIMES,
  LruBlobStore,
  QUIP_LIMITS,
  QuipBook,
  hashBytes,
  sodium,
  validateQuip,
  type QuipBlobRef,
  type QuipMeta,
  type SavedQuip,
} from '@crewmap/p2p';
import { kvGet, kvSet } from './db';

/** Blob files (content-addressed) live in the app documents dir; the LRU index and the collection in the local kv. */
const dir = () => {
  const d = new Directory(Paths.document, 'quips');
  if (!d.exists) d.create();
  return d;
};
const fileOf = (h: string) => new File(dir(), `${h}.bin`);

const fromB64 = (s: string): Uint8Array => sodium().from_base64(s, sodium().base64_variants.ORIGINAL);
const toB64 = (b: Uint8Array): string => sodium().to_base64(b, sodium().base64_variants.ORIGINAL);

export const quipStore = new LruBlobStore(
  {
    read: async (h) => {
      const f = fileOf(h);
      return f.exists ? fromB64(await f.base64()) : null;
    },
    write: async (h, bytes) => {
      const f = fileOf(h);
      f.create({ overwrite: true });
      f.write(toB64(bytes), { encoding: 'base64' });
    },
    remove: async (h) => {
      const f = fileOf(h);
      if (f.exists) f.delete();
    },
  },
  { get: kvGet, set: kvSet },
);
export const quipBook = new QuipBook({ get: kvGet, set: kvSet }, quipStore);

export interface ReceivedEntry {
  id: string;
  from: string;
  meta: QuipMeta;
  at: number;
}

interface QuipState {
  saved: SavedQuip[];
  /** Recent quips from friends, with "Save to my quips". */
  received: ReceivedEntry[];
}

export const useQuips = create<QuipState>(() => ({ saved: [], received: [] }));

export const refreshQuips = async (): Promise<void> => useQuips.setState({ saved: await quipBook.all() });

export function addReceived(e: ReceivedEntry): void {
  useQuips.setState((s) => ({ received: [e, ...s.received.filter((r) => r.id !== e.id)].slice(0, 20) }));
}

/** Local file of a blob, for playback (audio gets an extension the player recognises) and display (images). */
export async function blobUri(ref: QuipBlobRef, audio: boolean): Promise<string | null> {
  if (!audio) {
    const f = fileOf(ref.h);
    return f.exists ? f.uri : null;
  }
  const bytes = await quipStore.get(ref.h);
  if (!bytes) return null;
  const f = new File(Paths.cache, `quip-${ref.h}.m4a`);
  if (!f.exists) {
    f.create({ overwrite: true });
    f.write(toB64(bytes), { encoding: 'base64' });
  }
  return f.uri;
}

export async function blobsOf(q: QuipMeta): Promise<Map<string, Uint8Array> | null> {
  const out = new Map<string, Uint8Array>();
  for (const r of [q.a, q.i]) {
    if (!r) continue;
    const b = await quipStore.get(r.h);
    if (!b) return null;
    out.set(r.h, b);
  }
  return out;
}

export type PickedImage = { ok: true; bytes: Uint8Array; mime: string } | { ok: false; reason: 'canceled' | 'tooBig' | 'type' };

/**
 * Pick an image or GIF from the device. GIFs must fit the 250 KB limit directly; static images (JPEG/PNG/WebP/HEIC)
 * over 80 KB are automatically re-encoded on device via `platform.photos.compress` so any phone photo works.
 */
export async function pickImage(): Promise<PickedImage> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['image/*'], copyToCacheDirectory: true });
  const a = res.canceled ? null : res.assets[0];
  if (!a) return { ok: false, reason: 'canceled' };
  const mime = (a.mimeType ?? '').toLowerCase();
  if (mime === 'image/gif') {
    if ((a.size ?? 0) > QUIP_LIMITS.maxGifBytes) return { ok: false, reason: 'tooBig' };
    const bytes = fromB64(await new File(a.uri).base64());
    if (bytes.length > QUIP_LIMITS.maxGifBytes) return { ok: false, reason: 'tooBig' };
    return { ok: true, bytes, mime };
  }
  if (!mime.startsWith('image/')) return { ok: false, reason: 'type' };
  if ((IMAGE_MIMES as readonly string[]).includes(mime) && (a.size ?? Infinity) <= QUIP_LIMITS.maxImageBytes) {
    const bytes = fromB64(await new File(a.uri).base64());
    if (bytes.length <= QUIP_LIMITS.maxImageBytes) return { ok: true, bytes, mime };
  }
  // Re-encode oversized or HEIC/HEIF static images down to ≤ 80 KB JPEG using the native photo compressor.
  try {
    const out = await platform.photos.compress(a.uri, 1024, QUIP_LIMITS.maxImageBytes);
    if (!out) return { ok: false, reason: 'tooBig' };
    const bytes = fromB64(await new File(out.uri).base64());
    if (bytes.length > QUIP_LIMITS.maxImageBytes) return { ok: false, reason: 'tooBig' };
    return { ok: true, bytes, mime: 'image/jpeg' };
  } catch {
    return { ok: false, reason: 'tooBig' };
  }
}

export interface NewQuip {
  cap?: string;
  emoji?: string;
  by: string;
  audio?: { base64: string; ms: number };
  image?: { bytes: Uint8Array; mime: string };
}

/** Store the blobs, add the quip to My quips. */
export async function createQuip(n: NewQuip): Promise<SavedQuip | null> {
  const meta: QuipMeta = { by: n.by };
  const cap = n.cap?.trim();
  if (cap) meta.cap = cap;
  if (n.emoji?.trim()) meta.emoji = n.emoji.trim();
  if (n.audio) {
    const b = fromB64(n.audio.base64);
    meta.a = { h: hashBytes(b), n: b.length, mime: 'audio/mp4', ms: n.audio.ms };
    await quipStore.put(meta.a.h, b);
  }
  if (n.image) {
    meta.i = { h: hashBytes(n.image.bytes), n: n.image.bytes.length, mime: n.image.mime };
    await quipStore.put(meta.i.h, n.image.bytes);
  }
  if (validateQuip(meta)) return null;
  const r = await quipBook.save(meta, true);
  await refreshQuips();
  return r === 'saved' || r === 'exists' ? ((await quipBook.all()).find((q) => q.cap === meta.cap && q.a?.h === meta.a?.h && q.i?.h === meta.i?.h) ?? null) : null;
}

export async function saveReceived(meta: QuipMeta): Promise<'saved' | 'exists' | 'invalid' | 'full'> {
  const r = await quipBook.save(meta, false);
  await refreshQuips();
  return r;
}

export async function renameQuip(id: string, cap: string): Promise<void> {
  await quipBook.rename(id, cap);
  await refreshQuips();
}

export async function deleteQuip(id: string): Promise<void> {
  await quipBook.remove(id);
  await refreshQuips();
}

/** Voice clip as the existing custom-emote clip (standard base64) for older peers. */
export { toB64 as quipB64 };
