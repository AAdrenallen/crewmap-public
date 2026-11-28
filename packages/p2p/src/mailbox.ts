import { canonical, mergeLogs, replay, type CircleOp, type CircleState } from './crypto/circle';
import { openFrom, sealTo } from './crypto/envelope';
import type { DeviceIdentity } from './crypto/identity';
import { fromUtf8, hex, sodium, u32be, unb64, utf8, concat } from './crypto/sodium';
import { publishSealed, subscribeSealedMany } from './transport/inviteChannel';
import type { RelayPool } from './transport/types';

/**
 * Per-device mailbox for membership logs (independent of epoch keys, so a member who was offline across rotations
 * still catches up). Topic = BLAKE2b(boxPk || week) → relays can't link weeks. Payloads are sealed to the device.
 */
const WEEK_MS = 7 * 86_400_000;
export const MAILBOX_TTL_S = 30 * 86_400;
/** Keep each relay event under ~40 KB. */
const CHUNK_BYTES = 30_000;

export function mailboxTopic(boxPk: Uint8Array, week: number): string {
  return hex(sodium().crypto_generichash(16, concat(utf8('crewmap/mailbox/v1'), boxPk, u32be(week))));
}

export const weekIndex = (t: number) => Math.floor(t / WEEK_MS);

type MailMsg =
  | { type: 'log'; circleId: string; ops: CircleOp[]; part: number; parts: number; batch: string }
  | { type: 'log-request'; circleId: string; from: string; fromSeq: number };

function chunkOps(ops: CircleOp[]): CircleOp[][] {
  const out: CircleOp[][] = [];
  let cur: CircleOp[] = [];
  let size = 0;
  for (const op of ops) {
    const s = canonical(op).length;
    if (cur.length > 0 && size + s > CHUNK_BYTES) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(op);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export class Mailbox {
  private sub: { close(): void } | null = null;
  private readonly partial = new Map<string, { parts: number; got: Map<number, CircleOp[]> }>();

  constructor(
    private readonly pool: RelayPool,
    private readonly relays: () => string[],
    private readonly me: DeviceIdentity,
    private readonly onLog: (circleId: string, ops: CircleOp[]) => void,
    private readonly onLogRequest: (circleId: string, from: string, fromSeq: number) => void,
  ) {}

  /** Listen on this and the previous 4 weeks' topics in one combined subscription. */
  start(now: number, sinceS: number): void {
    this.sub?.close();
    const w = weekIndex(now);
    const topics = [0, 1, 2, 3, 4].map((d) => mailboxTopic(this.me.boxPk, w - d));
    this.sub = subscribeSealedMany(this.pool, this.relays(), topics, sinceS, (sealed) => {
      try {
        this.handle(JSON.parse(fromUtf8(openFrom(this.me, sealed))) as MailMsg);
      } catch {
        // not for us
      }
    });
  }

  stop(): void {
    this.sub?.close();
    this.sub = null;
  }

  /** Admin → member: send the log (or its tail) sealed to that member's box key. */
  async sendLog(to: { boxPk: string }, circleId: string, ops: CircleOp[], now: number): Promise<boolean> {
    const pk = unb64(to.boxPk);
    const chunks = chunkOps(ops);
    const batch = hex(sodium().randombytes_buf(8));
    const topic = mailboxTopic(pk, weekIndex(now));
    let ok = true;
    for (let i = 0; i < chunks.length; i++) {
      const msg: MailMsg = { type: 'log', circleId, ops: chunks[i]!, part: i, parts: chunks.length, batch };
      ok = (await publishSealed(this.pool, this.relays(), topic, sealTo(pk, utf8(JSON.stringify(msg))), MAILBOX_TTL_S, now)) && ok;
    }
    return ok;
  }

  /** Member → admin: "my log stops at fromSeq, send me the rest". */
  async requestLog(admin: { boxPk: string }, circleId: string, fromSeq: number, now: number): Promise<boolean> {
    const pk = unb64(admin.boxPk);
    const msg: MailMsg = { type: 'log-request', circleId, from: this.me.deviceId, fromSeq };
    return publishSealed(this.pool, this.relays(), mailboxTopic(pk, weekIndex(now)), sealTo(pk, utf8(JSON.stringify(msg))), 7 * 86_400, now);
  }

  private handle(m: MailMsg): void {
    if (m.type === 'log-request') {
      this.onLogRequest(m.circleId, m.from, m.fromSeq);
      return;
    }
    const p = this.partial.get(m.batch) ?? { parts: m.parts, got: new Map<number, CircleOp[]>() };
    p.got.set(m.part, m.ops);
    this.partial.set(m.batch, p);
    if (p.got.size < p.parts) return;
    this.partial.delete(m.batch);
    const ops = [...p.got.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, o]) => o);
    this.onLog(m.circleId, ops);
  }
}

/**
 * Merge a received (possibly partial) log into ours. Returns the new full log, or 'gap' if theirs starts after our
 * head (we need the missing range), or null if nothing changed / invalid.
 */
export function absorbLog(ours: CircleOp[], received: CircleOp[], me: DeviceIdentity): CircleOp[] | 'gap' | null {
  if (received.length === 0) return null;
  const first = received[0]!.seq;
  let candidate: CircleOp[];
  if (first === 0) candidate = received;
  else {
    if (first > ours.length) return 'gap';
    candidate = [...ours.slice(0, first), ...received];
  }
  try {
    const merged = ours.length === 0 ? (replay(candidate, me), candidate) : mergeLogs(ours, candidate, me);
    return merged === ours ? null : merged;
  } catch {
    return null;
  }
}

export function stateOrNull(ops: CircleOp[], me: DeviceIdentity): CircleState | null {
  try {
    return replay(ops, me);
  } catch {
    return null;
  }
}
