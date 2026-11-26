import { DRIVE_ALONG } from './thresholds';

/**
 * Drive-along / group-drive session (D31, D46): one organiser invites friends (one by one, or a whole crew); each
 * invitee accepts, declines or ignores (lapses). Everyone joined exchanges live presence among themselves only. A
 * group drive is a session with a destination picked by the host. Pure and clock-free: every transition takes `now`.
 */
export type MemberState = 'invited' | 'joined' | 'declined' | 'left';

export interface GroupDest {
  name: string;
  lat: number;
  lng: number;
}

export interface DriveAlongSession {
  sid: string;
  owner: string;
  /** Crew the session was started for (whole-crew drive-along), else null. */
  crew: string | null;
  startedAt: number;
  members: Record<string, { state: MemberState; at: number; name: string }>;
  /** Last live presence per member. */
  heard: Record<string, number>;
  /** Owner shares the route line with joined members. */
  shareRoute: boolean;
  /** Group drive: where everyone is heading, picked by the host. Null for a plain drive-along. */
  dest: GroupDest | null;
  /** Bumps each time the host changes the destination; arrivals for an older one are ignored. */
  destRev: number;
  /** member id to arrival time (sender clock) for the current destination. */
  arrived: Record<string, number>;
  /** A destination change from the host that I have not accepted yet. */
  pendingDest: { dest: GroupDest; rev: number } | null;
}

/**
 * Wire ops (payload of router kind 'drive-along'). Unknown ops / versions are ignored, and extra fields are ignored by
 * older readers: a build without the `groupDrive` capability reads a group invite as a plain drive-along invite.
 */
export type DriveAlongOp =
  | { v: 1; op: 'invite'; sid: string; t: number; crew: string | null; members: { id: string; name: string }[]; ownerName: string; dest?: GroupDest; rev?: number }
  | { v: 1; op: 'accept' | 'decline' | 'leave' | 'stop'; sid: string; t: number }
  /** Group drive: the host moved the destination. */
  | { v: 1; op: 'dest'; sid: string; t: number; dest: GroupDest; rev: number }
  /** Group drive: the sender reached the destination of revision `rev`. */
  | { v: 1; op: 'arrive'; sid: string; t: number; rev: number };

export function parseDest(raw: unknown): GroupDest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.lat !== 'number' || typeof o.lng !== 'number' || !Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return null;
  if (Math.abs(o.lat) > 90 || Math.abs(o.lng) > 180) return null;
  return { name: typeof o.name === 'string' ? o.name.slice(0, 80) : '', lat: o.lat, lng: o.lng };
}

export function newSession(sid: string, me: { id: string; name: string }, invitees: { id: string; name: string }[], crew: string | null, now: number, dest: GroupDest | null = null): DriveAlongSession {
  const members: DriveAlongSession['members'] = { [me.id]: { state: 'joined', at: now, name: me.name } };
  for (const i of invitees) if (i.id !== me.id) members[i.id] = { state: 'invited', at: now, name: i.name };
  return { sid, owner: me.id, crew, startedAt: now, members, heard: {}, shareRoute: false, dest, destRev: 0, arrived: {}, pendingDest: null };
}

export function inviteOp(s: DriveAlongSession, now: number): DriveAlongOp {
  return {
    v: 1,
    op: 'invite',
    sid: s.sid,
    t: now,
    crew: s.crew,
    members: Object.entries(s.members).filter(([id]) => id !== s.owner).map(([id, m]) => ({ id, name: m.name })),
    ownerName: s.members[s.owner]?.name ?? '',
    ...(s.dest ? { dest: s.dest, rev: s.destRev } : {}),
  };
}

export function parseOp(raw: unknown): DriveAlongOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.sid !== 'string' || o.sid.length === 0 || o.sid.length > 64 || typeof o.t !== 'number') return null;
  if (o.op === 'invite') {
    if (!Array.isArray(o.members) || o.members.length > 50 || typeof o.ownerName !== 'string') return null;
    const members = (o.members as unknown[]).filter((m): m is { id: string; name: string } => !!m && typeof (m as { id: unknown }).id === 'string' && typeof (m as { name: unknown }).name === 'string');
    const dest = parseDest(o.dest);
    return { v: 1, op: 'invite', sid: o.sid, t: o.t, crew: typeof o.crew === 'string' ? o.crew : null, members, ownerName: o.ownerName.slice(0, 60), ...(dest ? { dest, rev: typeof o.rev === 'number' ? o.rev : 0 } : {}) };
  }
  if (o.op === 'dest') {
    const dest = parseDest(o.dest);
    return dest && typeof o.rev === 'number' ? { v: 1, op: 'dest', sid: o.sid, t: o.t, dest, rev: o.rev } : null;
  }
  if (o.op === 'arrive') return typeof o.rev === 'number' ? { v: 1, op: 'arrive', sid: o.sid, t: o.t, rev: o.rev } : null;
  if (o.op === 'accept' || o.op === 'decline' || o.op === 'leave' || o.op === 'stop') return { v: 1, op: o.op, sid: o.sid, t: o.t };
  return null;
}

/** Session as an invitee sees it after accepting an invite (the organiser and the other invitees). */
export function sessionFromInvite(op: Extract<DriveAlongOp, { op: 'invite' }>, from: string, me: string, now: number): DriveAlongSession {
  const members: DriveAlongSession['members'] = { [from]: { state: 'joined', at: now, name: op.ownerName } };
  for (const m of op.members) members[m.id] = { state: m.id === me ? 'joined' : 'invited', at: now, name: m.name };
  return { sid: op.sid, owner: from, crew: op.crew, startedAt: now, members, heard: {}, shareRoute: false, dest: op.dest ?? null, destRev: op.rev ?? 0, arrived: {}, pendingDest: null };
}

/** Who takes over when the host leaves: the joined member with the smallest id, so every peer agrees without a message. */
export function successor(s: DriveAlongSession, leaving: string): string | null {
  const ids = Object.entries(s.members)
    .filter(([id, m]) => id !== leaving && m.state === 'joined')
    .map(([id]) => id)
    .sort();
  return ids[0] ?? null;
}

/** Host: move the destination for everyone (they get a prompt). */
export function changeDest(s: DriveAlongSession, dest: GroupDest): DriveAlongSession {
  return { ...s, dest, destRev: s.destRev + 1, arrived: {}, pendingDest: null };
}

/** Member: take the host's new destination. */
export function adoptDest(s: DriveAlongSession): DriveAlongSession {
  const p = s.pendingDest;
  return p ? { ...s, dest: p.dest, destRev: p.rev, arrived: {}, pendingDest: null } : s;
}

export function markArrived(s: DriveAlongSession, id: string, at: number): DriveAlongSession {
  return s.arrived[id] !== undefined ? s : { ...s, arrived: { ...s.arrived, [id]: at } };
}

/**
 * Apply an op from `from`. Returns the new session, or null when the session is over for us (organiser stopped it,
 * or the organiser left with nobody to take over). Ops for another session are ignored (returned unchanged).
 */
export function applyOp(s: DriveAlongSession, from: string, op: DriveAlongOp, now: number): DriveAlongSession | null {
  if (op.sid !== s.sid) return s;
  if (op.op === 'stop') return from === s.owner ? null : s;
  const cur = s.members[from];
  if (op.op === 'dest') {
    if (from !== s.owner || op.rev <= s.destRev || (s.pendingDest && op.rev <= s.pendingDest.rev)) return s;
    return { ...s, pendingDest: { dest: op.dest, rev: op.rev } };
  }
  if (op.op === 'arrive') return cur?.state === 'joined' && op.rev === s.destRev && s.dest ? markArrived(s, from, op.t) : s;
  if (op.op === 'leave' && from === s.owner) {
    // The host left: hand over rather than end the drive for everyone.
    const next = successor(s, from);
    if (!next) return null;
    return { ...s, owner: next, members: { ...s.members, [from]: { ...s.members[from]!, state: 'left', at: now } } };
  }
  if (op.op === 'invite') {
    // Organiser re-sent (more people added): merge newcomers as invited.
    if (from !== s.owner) return s;
    const members = { ...s.members };
    for (const m of op.members) if (!members[m.id]) members[m.id] = { state: 'invited', at: now, name: m.name };
    const rev = op.rev ?? 0;
    const late = !!op.dest && rev > s.destRev && !(s.pendingDest && s.pendingDest.rev >= rev);
    return { ...s, members, ...(late ? { pendingDest: { dest: op.dest!, rev } } : {}) };
  }
  if (!cur) return s;
  const state: MemberState = op.op === 'accept' ? 'joined' : op.op === 'decline' ? 'declined' : 'left';
  return { ...s, members: { ...s.members, [from]: { ...cur, state, at: now } } };
}

/** Members (other than me) who receive my live presence. */
export function liveTargets(s: DriveAlongSession, me: string): string[] {
  return Object.entries(s.members)
    .filter(([id, m]) => id !== me && m.state === 'joined')
    .map(([id]) => id)
    .sort();
}

export function heard(s: DriveAlongSession, from: string, now: number): DriveAlongSession {
  const m = s.members[from];
  if (!m) return s;
  // A live update from an invitee means they joined (their accept may still be in flight).
  const members = m.state === 'invited' ? { ...s.members, [from]: { ...m, state: 'joined' as const, at: now } } : s.members;
  return { ...s, members, heard: { ...s.heard, [from]: now } };
}

export type EndReason = 'stopped' | 'parked' | 'silence' | 'alone' | 'max' | 'arrived';

/**
 * Whether the session should end now. `parkedSince`: when my last drive ended (null while driving or unknown).
 * Invites lapse after `inviteTtlMs`; with nobody left joined or invited, the session is over.
 */
export function tick(s: DriveAlongSession, me: string, now: number, parkedSince: number | null): { session: DriveAlongSession; end: EndReason | null } {
  let members = s.members;
  for (const [id, m] of Object.entries(s.members)) {
    if (m.state === 'invited' && now - m.at > DRIVE_ALONG.inviteTtlMs) members = { ...members, [id]: { ...m, state: 'declined', at: now } };
  }
  const session = members === s.members ? s : { ...s, members };
  if (now - s.startedAt > DRIVE_ALONG.maxSessionMs) return { session, end: 'max' };
  const others = Object.entries(members).filter(([id]) => id !== me);
  const live = others.filter(([, m]) => m.state === 'joined' || m.state === 'invited');
  if (live.length === 0) return { session, end: 'alone' };
  // Parking that began before the session does not count: a drive-along started while parked must survive its first tick.
  if (parkedSince !== null && now - Math.max(parkedSince, s.startedAt) > DRIVE_ALONG.parkedEndMs) return { session, end: 'parked' };
  const mine = s.arrived[me];
  if (s.dest && mine !== undefined && now - mine > DRIVE_ALONG.arrivedLingerMs) return { session, end: 'arrived' };
  const joined = others.filter(([, m]) => m.state === 'joined');
  if (joined.length > 0 && live.length === joined.length) {
    const last = Math.max(...joined.map(([id, m]) => s.heard[id] ?? m.at));
    if (now - last > DRIVE_ALONG.silenceEndMs) return { session, end: 'silence' };
  }
  return { session, end: null };
}

/** Live presence period for me right now. */
export function livePeriodMs(meDriving: boolean): number {
  return meDriving ? DRIVE_ALONG.liveDrivingMs : DRIVE_ALONG.liveIdleMs;
}
