import { platform } from '@crewmap/platform';
import {
  absorbLog,
  acceptJoinRequest,
  buildJoinRequest,
  CircleAdmin,
  completeJoin,
  createInvite,
  decodeInvite,
  DEFAULT_PUBLIC_RELAYS,
  encodeInvite,
  exportIdentity,
  generateIdentity,
  importIdentity,
  initSodium,
  inviteTopics,
  b64,
  unb64,
  publishSealed,
  publishJoinCode,
  retractJoinCode,
  generateJoinCode,
  JOIN_CODE_MAX_LIVE,
  JOIN_CODE_TTL_MS,
  type PublishedCode,
  replay,
  subscribeSealed,
  type CircleOp,
  type CircleState,
  type DeviceIdentity,
  type InviteToken,
  type PendingInvite,
  type RelayPool,
  type StoredInviteV1,
} from '@crewmap/p2p';
import { deleteCircleData, kvGet, kvSet, loadCircleOps, saveCircleOps } from './db';

const IDENTITY_KEY = 'crewmap.identity.v1';

export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  await initSodium(platform.sodium);
  const stored = await platform.keys.get(IDENTITY_KEY);
  if (stored) return importIdentity(stored);
  const id = generateIdentity();
  await platform.keys.set(IDENTITY_KEY, exportIdentity(id));
  return id;
}

export async function deleteIdentity(): Promise<void> {
  await platform.keys.remove(IDENTITY_KEY);
}

type StoredInvite = StoredInviteV1;
export const invitesKey = (circleId: string) => `invites:${circleId}`;
const codesKey = (circleId: string) => `joinCodes:${circleId}`;

/** Relays a short code is published on and looked up from: the joiner has no hints yet, so always include the public set. */
export const codeRelays = (relays: string[]): string[] => [...new Set([...relays, ...DEFAULT_PUBLIC_RELAYS])];

/** The device mailbox (shared by all crews, see Crews) as one crew uses it to propagate its membership log. */
export interface CrewMail {
  sendLog(to: { boxPk: string }, circleId: string, ops: CircleOp[], now: number): Promise<boolean>;
  requestLog(admin: { boxPk: string }, circleId: string, fromSeq: number, now: number): Promise<boolean>;
}

/**
 * One crew: membership log (persisted), derived state with epoch keys, invites (QR / one-time link), membership
 * propagation through the device mailbox, and weekly key rotation.
 */
export class CircleManager {
  ops: CircleOp[] = [];
  state: CircleState | null = null;
  private inviteSubs = new Map<string, { close(): void }>();
  private readonly listeners = new Set<(st: CircleState | null) => void>();

  constructor(
    readonly me: DeviceIdentity,
    private readonly pool: RelayPool,
    private readonly mail: () => CrewMail | null,
    private readonly relays: () => string[] = () => DEFAULT_PUBLIC_RELAYS,
  ) {}

  onChange(cb: (st: CircleState | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }

  get isAdmin(): boolean {
    const m = this.state?.members.get(this.me.deviceId);
    return m?.role === 'owner' || m?.role === 'admin';
  }

  async load(circleId: string): Promise<void> {
    this.ops = await loadCircleOps(circleId);
    this.state = this.ops.length ? replay(this.ops, this.me) : null;
    this.emit();
  }

  /** Listen for this crew's pending invites. */
  async startNetwork(): Promise<void> {
    if (!this.state) return;
    for (const inv of await kvGet<StoredInvite[]>(invitesKey(this.state.circleId), [])) if (!inv.used && inv.expiresAt > Date.now()) this.listenInvite(inv);
  }

  stop(): void {
    for (const s of this.inviteSubs.values()) s.close();
    this.inviteSubs.clear();
  }

  async create(name: string, myName: string): Promise<void> {
    this.ops = new CircleAdmin(this.me).create(name.trim() || 'Crew', myName, Date.now());
    await this.commit();
  }

  /** New one-time invite: returns the `crewmap://join#…` link (also shown as a QR code). */
  async invite(ttlMs?: number): Promise<{ link: string; token: InviteToken }> {
    if (!this.state) throw new Error('no circle');
    const key = invitesKey(this.state.circleId);
    const { token, pending } = createInvite(this.state, this.me, Date.now(), this.relays().slice(0, 3), ttlMs);
    const stored: StoredInvite = { inviteId: pending.inviteId, secret: b64(pending.secret), expiresAt: pending.expiresAt, used: false };
    await kvSet(key, [...(await kvGet<StoredInvite[]>(key, [])).filter((i) => i.expiresAt > Date.now()), stored]);
    this.listenInvite(stored);
    return { link: encodeInvite(token), token };
  }

  /**
   * Short code (D34): a dedicated 10-minute one-time invite, sealed under the code and published on the relays.
   * At most JOIN_CODE_MAX_LIVE live codes per crew.
   */
  async codeInvite(): Promise<{ code: string; expiresAt: number }> {
    if (!this.state) throw new Error('no circle');
    const key = codesKey(this.state.circleId);
    const live = (await kvGet<PublishedCode[]>(key, [])).filter((c) => c.expiresAt > Date.now());
    if (live.length >= JOIN_CODE_MAX_LIVE) throw new Error('too many codes');
    const { link, token } = await this.invite(JOIN_CODE_TTL_MS);
    const pub = await publishJoinCode(this.pool, codeRelays(this.relays()), generateJoinCode(), token.i, link);
    await kvSet(key, [...live, pub]);
    return { code: pub.code, expiresAt: pub.expiresAt };
  }

  /** Once its invite is used, pull the code's sealed link off the relays (best effort; the invite is already spent). */
  private async retractCode(circleId: string, inviteId: string): Promise<void> {
    const key = codesKey(circleId);
    const all = await kvGet<PublishedCode[]>(key, []);
    const hit = all.find((c) => c.inviteId === inviteId);
    if (!hit) return;
    await kvSet(key, all.filter((c) => c !== hit && c.expiresAt > Date.now()));
    await retractJoinCode(this.pool, codeRelays(this.relays()), hit);
  }

  private listenInvite(inv: StoredInvite): void {
    if (this.inviteSubs.has(inv.inviteId)) return;
    const secret = unb64(inv.secret);
    const topics = inviteTopics(secret);
    const sub = subscribeSealed(this.pool, this.relays(), topics.request, Math.floor(Date.now() / 1000) - 86_400, (sealed) => {
      void this.handleJoin(inv, sealed);
    });
    this.inviteSubs.set(inv.inviteId, sub);
  }

  private async handleJoin(inv: StoredInvite, sealed: Uint8Array): Promise<void> {
    if (!this.state || inv.used) return;
    const key = invitesKey(this.state.circleId);
    const pending: PendingInvite = { inviteId: inv.inviteId, secret: unb64(inv.secret), expiresAt: inv.expiresAt, used: inv.used };
    let res: ReturnType<typeof acceptJoinRequest>;
    try {
      res = acceptJoinRequest(this.state, this.me, pending, sealed, Date.now());
    } catch {
      return;
    }
    inv.used = true;
    await kvSet(key, (await kvGet<StoredInvite[]>(key, [])).map((i) => (i.inviteId === inv.inviteId ? { ...i, used: true } : i)));
    this.inviteSubs.get(inv.inviteId)?.close();
    this.inviteSubs.delete(inv.inviteId);
    void this.retractCode(this.state.circleId, inv.inviteId).catch(() => undefined);
    this.ops = [...this.ops, ...res.ops];
    await this.commit();
    await publishSealed(this.pool, this.relays(), inviteTopics(pending.secret).reply, res.reply, 86_400);
    await this.propagate();
  }

  /** Joiner side: send the request and wait (up to 10 min) for the issuer's reply. */
  async join(link: string, myName: string): Promise<void> {
    const token = decodeInvite(link);
    if (token.e < Date.now()) throw new Error('invite expired');
    const secret = unb64(token.k);
    const topics = inviteTopics(secret);
    const relays = token.r.length ? token.r : this.relays();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close();
        reject(new Error('no answer from the inviter'));
      }, 10 * 60_000);
      const sub = subscribeSealed(this.pool, relays, topics.reply, Math.floor(Date.now() / 1000) - 60, (sealed) => {
        try {
          const st = completeJoin(this.me, token, sealed);
          clearTimeout(timer);
          sub.close();
          this.ops = st.ops;
          void this.commit().then(resolve, reject);
        } catch {
          // reply for someone else using the same topic: ignore
        }
      });
      void publishSealed(this.pool, relays, topics.request, buildJoinRequest(token, this.me, myName), 86_400);
    });
  }

  async remove(deviceId: string): Promise<void> {
    if (!this.state || !this.isAdmin) throw new Error('not an admin');
    this.ops = [...this.ops, ...new CircleAdmin(this.me).remove(this.state, deviceId, Date.now())];
    await this.commit();
    await this.propagate();
  }

  /** Admins rename the crew for everyone (a signed log op). */
  async rename(name: string): Promise<void> {
    if (!this.state || !this.isAdmin || !name.trim()) return;
    this.ops = [...this.ops, ...new CircleAdmin(this.me).rename(this.state, name.trim(), Date.now())];
    await this.commit();
    await this.propagate();
  }

  /** Weekly key rotation by the owner (also limits how long a stolen epoch key is useful). */
  async rotateIfStale(): Promise<void> {
    if (!this.state || this.state.ownerId !== this.me.deviceId) return;
    const lastEpoch = [...this.ops].reverse().find((o) => o.body.type === 'epoch');
    if (lastEpoch && Date.now() - lastEpoch.at < 7 * 86_400_000) return;
    this.ops = [...this.ops, ...new CircleAdmin(this.me).rotate(this.state, Date.now())];
    await this.commit();
    await this.propagate();
  }

  /** Forget the crew on this phone: its log, doc and invites (an admin removal rotates keys for everyone else). */
  async forget(): Promise<void> {
    const id = this.state?.circleId;
    this.stop();
    this.state = null;
    this.ops = [];
    if (id) {
      await deleteCircleData(id);
      await kvSet(invitesKey(id), []);
      await kvSet(codesKey(id), []);
    }
    this.emit();
  }

  /** Send the log tail to every current member's mailbox (they request the rest if they have a gap). */
  private async propagate(): Promise<void> {
    const mail = this.mail();
    const st = this.state;
    if (!st || !mail) return;
    const tail = this.ops.slice(-12);
    await Promise.all(
      [...st.members.values()].filter((m) => m.deviceId !== this.me.deviceId).map((m) => mail.sendLog(m, st.circleId, tail, Date.now())),
    );
  }

  async answerLogRequest(from: string, fromSeq: number): Promise<void> {
    if (!this.state || !this.isAdmin) return;
    const m = this.state.members.get(from);
    if (!m) return;
    await this.mail()?.sendLog(m, this.state.circleId, this.ops.slice(Math.max(0, fromSeq)), Date.now());
  }

  async absorb(received: CircleOp[]): Promise<void> {
    const r = absorbLog(this.ops, received, this.me);
    if (r === 'gap') {
      const st = this.state;
      const owner = st?.members.get(st.ownerId);
      if (st && owner) await this.mail()?.requestLog(owner, st.circleId, this.ops.length, Date.now());
      return;
    }
    if (!r) return;
    this.ops = r;
    await this.commit();
  }

  private async commit(): Promise<void> {
    const st = replay(this.ops, this.me);
    if (!st.members.has(this.me.deviceId)) {
      // We were removed.
      await this.forget();
      return;
    }
    this.state = st;
    await saveCircleOps(st.circleId, this.ops);
    this.emit();
  }
}
