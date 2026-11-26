import type { DeviceIdentity, PublicIdentity } from './identity';
import { deviceIdOf, verifyPublicIdentity } from './identity';
import { b64, concat, sodium, unb64, utf8 } from './sodium';

export type Role = 'owner' | 'admin' | 'member';

export interface Member extends PublicIdentity {
  name: string;
  role: Role;
  joinedAt: number;
}

export type OpBody =
  | { type: 'create'; name: string; owner: PublicIdentity; ownerName: string }
  | { type: 'add'; member: PublicIdentity; name: string; role: 'admin' | 'member'; inviteId?: string }
  | { type: 'remove'; deviceId: string }
  | { type: 'role'; deviceId: string; role: 'admin' | 'member' }
  | { type: 'rename'; name: string }
  | { type: 'epoch'; epoch: number; sealed: Record<string, string> };

export interface CircleOp {
  circleId: string;
  seq: number;
  /** b64 BLAKE2b of the previous op's canonical bytes ('' for seq 0). */
  prev: string;
  at: number;
  by: string;
  body: OpBody;
  sig: string;
}

export interface CircleState {
  circleId: string;
  name: string;
  ownerId: string;
  members: Map<string, Member>;
  removed: Set<string>;
  epoch: number;
  /** Epoch keys this device could open (only populated when a `self` identity is given). */
  epochKeys: Map<number, Uint8Array>;
  seq: number;
  head: string;
  ops: CircleOp[];
}

/** Deterministic JSON (sorted keys) so signatures and hashes are stable across devices. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

const OP_DOMAIN = 'crewmap/op/v1';

function opBytes(op: Omit<CircleOp, 'sig'>): Uint8Array {
  return utf8(OP_DOMAIN + canonical(op));
}

export function opHash(op: CircleOp): string {
  return b64(sodium().crypto_generichash(32, utf8(canonical(op))));
}

export function signOp(unsigned: Omit<CircleOp, 'sig'>, signer: DeviceIdentity): CircleOp {
  const sig = sodium().crypto_sign_detached(opBytes(unsigned), signer.signSk);
  return { ...unsigned, sig: b64(sig) };
}

export class CircleError extends Error {}

function memberCanAdmin(st: CircleState, deviceId: string): boolean {
  const m = st.members.get(deviceId);
  return m !== undefined && (m.role === 'owner' || m.role === 'admin');
}

/**
 * Replays a membership log and returns the resulting state. Throws on any invalid op (bad signature, broken
 * hash chain, unauthorised signer). If `self` is given, epoch keys sealed to it are opened.
 */
export function replay(ops: CircleOp[], self?: DeviceIdentity): CircleState {
  const s = sodium();
  if (ops.length === 0) throw new CircleError('empty log');
  const first = ops[0]!;
  if (first.body.type !== 'create' || first.seq !== 0 || first.prev !== '') throw new CircleError('log must start with create');
  const st: CircleState = {
    circleId: first.circleId,
    name: '',
    ownerId: '',
    members: new Map(),
    removed: new Set(),
    epoch: -1,
    epochKeys: new Map(),
    seq: -1,
    head: '',
    ops: [],
  };
  for (const op of ops) {
    if (op.circleId !== st.circleId) throw new CircleError('circle id mismatch');
    if (op.seq !== st.seq + 1) throw new CircleError(`bad seq ${op.seq}`);
    if (op.prev !== st.head) throw new CircleError(`broken chain at ${op.seq}`);
    // Resolve signer key: for create it's the embedded owner; otherwise a current member.
    let signerPk: Uint8Array;
    if (op.body.type === 'create') {
      if (!verifyPublicIdentity(op.body.owner) || op.body.owner.deviceId !== op.by) throw new CircleError('bad owner identity');
      signerPk = unb64(op.body.owner.signPk);
    } else {
      const m = st.members.get(op.by);
      if (!m) throw new CircleError(`signer ${op.by} is not a member`);
      if (!memberCanAdmin(st, op.by)) throw new CircleError(`signer ${op.by} is not an admin`);
      signerPk = unb64(m.signPk);
    }
    const { sig, ...unsigned } = op;
    if (!s.crypto_sign_verify_detached(unb64(sig), opBytes(unsigned), signerPk)) throw new CircleError(`bad signature at ${op.seq}`);

    const b = op.body;
    switch (b.type) {
      case 'create':
        st.name = b.name;
        st.ownerId = b.owner.deviceId;
        st.members.set(b.owner.deviceId, { ...b.owner, name: b.ownerName, role: 'owner', joinedAt: op.at });
        break;
      case 'add':
        if (!verifyPublicIdentity(b.member)) throw new CircleError('bad member identity');
        if (st.removed.has(b.member.deviceId)) throw new CircleError('removed device cannot be re-added');
        if (b.role === 'admin' && op.by !== st.ownerId) throw new CircleError('only the owner can add admins');
        st.members.set(b.member.deviceId, { ...b.member, name: b.name, role: b.role, joinedAt: op.at });
        break;
      case 'remove': {
        const target = st.members.get(b.deviceId);
        if (!target) throw new CircleError('remove: not a member');
        if (target.role === 'owner') throw new CircleError('cannot remove the owner');
        if (target.role === 'admin' && op.by !== st.ownerId && op.by !== b.deviceId) {
          throw new CircleError('only the owner can remove admins');
        }
        st.members.delete(b.deviceId);
        st.removed.add(b.deviceId);
        break;
      }
      case 'role':
        if (op.by !== st.ownerId) throw new CircleError('only the owner changes roles');
        if (!st.members.has(b.deviceId) || b.deviceId === st.ownerId) throw new CircleError('role: bad target');
        st.members.get(b.deviceId)!.role = b.role;
        break;
      case 'rename':
        st.name = b.name;
        break;
      case 'epoch': {
        if (b.epoch !== st.epoch + 1) throw new CircleError('epoch must increase by one');
        // The key must be sealed to exactly the current members.
        const ids = Object.keys(b.sealed).sort();
        const mem = [...st.members.keys()].sort();
        if (ids.length !== mem.length || ids.some((id, i) => id !== mem[i])) throw new CircleError('epoch sealed set ≠ members');
        st.epoch = b.epoch;
        if (self && b.sealed[self.deviceId]) {
          st.epochKeys.set(b.epoch, s.crypto_box_seal_open(unb64(b.sealed[self.deviceId]!), self.boxPk, self.boxSk));
        }
        break;
      }
    }
    // Membership changes must be followed by a new epoch before any content can be sent; enforced by
    // CircleAdmin, which always appends 'epoch' right after add/remove.
    st.seq = op.seq;
    st.head = opHash(op);
    st.ops.push(op);
  }
  return st;
}

/** Fresh epoch key sealed to every current member. */
function epochBody(st: CircleState): OpBody {
  const s = sodium();
  const key = s.crypto_aead_xchacha20poly1305_ietf_keygen();
  const sealed: Record<string, string> = {};
  for (const m of st.members.values()) sealed[m.deviceId] = b64(s.crypto_box_seal(key, unb64(m.boxPk)));
  return { type: 'epoch', epoch: st.epoch + 1, sealed };
}

/** Operations an owner/admin device performs on its circle. Each returns the new ops to broadcast. */
export class CircleAdmin {
  constructor(private readonly me: DeviceIdentity) {}

  create(name: string, myName: string, now: number): CircleOp[] {
    const circleId = b64(sodium().randombytes_buf(16));
    const createOp = signOp(
      {
        circleId,
        seq: 0,
        prev: '',
        at: now,
        by: this.me.deviceId,
        body: {
          type: 'create',
          name,
          owner: { deviceId: this.me.deviceId, signPk: b64(this.me.signPk), boxPk: b64(this.me.boxPk) },
          ownerName: myName,
        },
      },
      this.me,
    );
    const st = replay([createOp], this.me);
    return [createOp, this.append(st, epochBody(st), now)];
  }

  add(st: CircleState, member: PublicIdentity, name: string, now: number, role: 'admin' | 'member' = 'member', inviteId?: string): CircleOp[] {
    const body: OpBody = { type: 'add', member, name, role };
    if (inviteId) body.inviteId = inviteId;
    return this.withRotation(st, body, now);
  }

  remove(st: CircleState, deviceId: string, now: number): CircleOp[] {
    return this.withRotation(st, { type: 'remove', deviceId }, now);
  }

  setRole(st: CircleState, deviceId: string, role: 'admin' | 'member', now: number): CircleOp[] {
    return [this.append(st, { type: 'role', deviceId, role }, now)];
  }

  rename(st: CircleState, name: string, now: number): CircleOp[] {
    return [this.append(st, { type: 'rename', name }, now)];
  }

  /** Scheduled rotation (weekly) without membership change. */
  rotate(st: CircleState, now: number): CircleOp[] {
    return [this.append(st, epochBody(st), now)];
  }

  private withRotation(st: CircleState, body: OpBody, now: number): CircleOp[] {
    const op1 = this.append(st, body, now);
    const st2 = replay([...st.ops, op1], this.me);
    const op2 = this.append(st2, epochBody(st2), now);
    return [op1, op2];
  }

  private append(st: CircleState, body: OpBody, now: number): CircleOp {
    return signOp({ circleId: st.circleId, seq: st.seq + 1, prev: st.head, at: now, by: this.me.deviceId, body }, this.me);
  }
}

/**
 * Merge an incoming log with ours. Logs are linear; the longer valid log that extends ours wins. If two admins
 * appended concurrently (fork at the same seq), the branch whose first divergent op has the lower hash wins —
 * every device picks the same one, and the losing admin re-issues its change.
 */
export function mergeLogs(ours: CircleOp[], theirs: CircleOp[], self?: DeviceIdentity): CircleOp[] {
  let i = 0;
  while (i < ours.length && i < theirs.length && opHash(ours[i]!) === opHash(theirs[i]!)) i++;
  if (i === theirs.length) return ours;
  if (i === ours.length) {
    replay(theirs, self);
    return theirs;
  }
  replay(theirs, self);
  return opHash(theirs[i]!) < opHash(ours[i]!) ? theirs : ours;
}

export function circleIdBytes(circleId: string): Uint8Array {
  return unb64(circleId);
}

export { concat, deviceIdOf };
