import { openFrom, sealTo } from './crypto/envelope';
import type { DeviceIdentity } from './crypto/identity';
import { b64, fromUtf8, unb64, utf8 } from './crypto/sodium';

/**
 * Text chat, 1:1 or crew-wide. Carried as router kind `chat` inside the crew envelope (crew epoch key, signed by the
 * sender). A 1:1 message is additionally sealed to the recipient's box key (`crypto_box_seal`), because the crew key
 * is shared: other members can open the envelope but never the text. History is never sent to peers.
 */
export const CHAT_MAX_CHARS = 1000;

export interface ChatMessage {
  id: string;
  from: string;
  /** Recipient deviceId, or null for the whole crew. */
  to: string | null;
  text: string;
  t: number;
}

interface Wire {
  v: 1;
  /** Crew message in clear (inside the crew envelope). */
  m?: ChatMessage;
  /** 1:1 message sealed to the recipient. */
  s?: string;
}

export function validateChat(m: ChatMessage): boolean {
  return (
    typeof m.id === 'string' &&
    m.id.length > 0 &&
    m.id.length <= 64 &&
    typeof m.from === 'string' &&
    (m.to === null || typeof m.to === 'string') &&
    typeof m.text === 'string' &&
    m.text.trim().length > 0 &&
    m.text.length <= CHAT_MAX_CHARS &&
    Number.isFinite(m.t)
  );
}

/** Payload bytes for router kind `chat`. `recipientBoxPk` is required for 1:1 messages. */
export function encodeChat(m: ChatMessage, recipientBoxPk?: Uint8Array): Uint8Array {
  if (!validateChat(m)) throw new Error('invalid chat message');
  if (m.to === null) return utf8(JSON.stringify({ v: 1, m } satisfies Wire));
  if (!recipientBoxPk) throw new Error('1:1 chat needs the recipient key');
  return utf8(JSON.stringify({ v: 1, s: b64(sealTo(recipientBoxPk, utf8(JSON.stringify(m)))) } satisfies Wire));
}

/**
 * Decode an incoming `chat` payload. `sender` is the envelope's verified sender: the inner `from` must match it
 * (the sealed box itself is anonymous). A 1:1 message must be addressed to `me`. Returns null when unreadable.
 */
export function decodeChat(payload: Uint8Array, sender: string, me: DeviceIdentity): ChatMessage | null {
  try {
    const w = JSON.parse(fromUtf8(payload)) as Wire;
    if (w.v !== 1) return null;
    let m: ChatMessage;
    if (w.m) {
      m = w.m;
      if (m.to !== null) return null;
    } else if (typeof w.s === 'string') {
      m = JSON.parse(fromUtf8(openFrom(me, unb64(w.s)))) as ChatMessage;
      if (m.to !== me.deviceId) return null;
    } else return null;
    if (m.from !== sender || !validateChat(m)) return null;
    return { id: m.id, from: m.from, to: m.to, text: m.text, t: m.t };
  } catch {
    return null;
  }
}

/** Thread key: the friend's deviceId for 1:1, `crew:<circleId>` for a crew. */
export const crewThread = (circleId: string) => `crew:${circleId}`;
export const isCrewThread = (thread: string) => thread.startsWith('crew:');
export const crewOfThread = (thread: string) => (isCrewThread(thread) ? thread.slice(5) : null);

export type ChatStatus = 'sent' | 'delivered' | 'failed';

export interface StoredChat extends ChatMessage {
  thread: string;
  mine: boolean;
  status: ChatStatus;
  read: boolean;
}

/** Thread an incoming message belongs to. */
export function threadOf(m: ChatMessage, me: string, circleId: string): string {
  if (m.to === null) return crewThread(circleId);
  return m.from === me ? m.to : m.from;
}

/**
 * In-memory chat store over a persistence adapter (SQLite in the app, memory in tests): dedupe by id, delivery
 * state, unread counts and the retention cutoff.
 */
export interface ChatPersistence {
  put(m: StoredChat): Promise<void>;
  has?(id: string): Promise<boolean>;
  setStatus(id: string, status: ChatStatus): Promise<void>;
  markRead(thread: string): Promise<void>;
  thread(thread: string): Promise<StoredChat[]>;
  unread(): Promise<Record<string, number>>;
  purgeBefore(t: number): Promise<number>;
  deleteThread(thread: string): Promise<void>;
}

export class ChatStore {
  constructor(private readonly p: ChatPersistence) {}

  /** Returns false for a duplicate. */
  async add(m: StoredChat): Promise<boolean> {
    if (this.p.has) {
      if (await this.p.has(m.id)) return false;
    } else {
      const existing = await this.p.thread(m.thread);
      if (existing.some((x) => x.id === m.id)) return false;
    }
    await this.p.put(m);
    return true;
  }

  /** Delivery only moves forward: sent → delivered; failed may be retried into delivered. */
  async setStatus(id: string, status: ChatStatus, current: ChatStatus): Promise<void> {
    if (current === 'delivered') return;
    await this.p.setStatus(id, status);
  }

  thread(thread: string): Promise<StoredChat[]> {
    return this.p.thread(thread);
  }

  markRead(thread: string): Promise<void> {
    return this.p.markRead(thread);
  }

  unread(): Promise<Record<string, number>> {
    return this.p.unread();
  }

  purge(retentionDays: number, now: number): Promise<number> {
    return this.p.purgeBefore(now - retentionDays * 86_400_000);
  }

  deleteThread(thread: string): Promise<void> {
    return this.p.deleteThread(thread);
  }
}

export class MemoryChatPersistence implements ChatPersistence {
  readonly rows = new Map<string, StoredChat>();
  async put(m: StoredChat): Promise<void> {
    this.rows.set(m.id, { ...m });
  }
  async setStatus(id: string, status: ChatStatus): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.status = status;
  }
  async markRead(thread: string): Promise<void> {
    for (const r of this.rows.values()) if (r.thread === thread) r.read = true;
  }
  async thread(thread: string): Promise<StoredChat[]> {
    return [...this.rows.values()].filter((r) => r.thread === thread).sort((a, b) => a.t - b.t);
  }
  async unread(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rows.values()) if (!r.mine && !r.read) out[r.thread] = (out[r.thread] ?? 0) + 1;
    return out;
  }
  async purgeBefore(t: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.t >= t) continue;
      this.rows.delete(id);
      n++;
    }
    return n;
  }
  async deleteThread(thread: string): Promise<void> {
    for (const [id, r] of this.rows) if (r.thread === thread) this.rows.delete(id);
  }
}
