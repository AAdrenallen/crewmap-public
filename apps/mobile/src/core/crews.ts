import { platform } from '@crewmap/platform';
import {
  chatAllowed,
  checkInAllowed,
  companionKindAllowed,
  crewThread,
  isCompanionKind,
  isMemoryKind,
  memoryKindAllowed,
  sealJson,
  unb64,
  DEFAULT_PUBLIC_RELAYS,
  DEFAULT_SHARING,
  Mailbox,
  mergePresence,
  migrateCrewStorage,
  migrateSharingGlobals,
  normalizePolicy,
  cleanOverride,
  resolveShare,
  type CircleState,
  type CrewStorageV1,
  type CrewStorageV2,
  SHARING_STORAGE_VER,
  type DeliveryReport,
  type DeviceIdentity,
  type FriendPresence,
  type Incoming,
  type Kind,
  type Presence,
  type RelayPool,
  type Router,
  type LegacySharingSettings,
  type SharingPolicy,
  type StoredInviteV1,
  type UserOverride,
  statsAllowed,
  lockoutRemainingMs,
  NO_LOCKOUT,
  normaliseJoinCode,
  recordCodeAttempt,
  resolveJoinCode,
  type CodeLockout,
} from '@crewmap/p2p';
import type { FriendReport, SignedHazardConfig } from '@crewmap/hazards';
import { DEFAULT_AVATAR, DEFAULT_CAR } from '@crewmap/shared/avatar';
import { haversineM } from '@crewmap/shared/geo';
import { restrictAgg, type AggSet, type Period } from '@crewmap/shared/stats';
import { displayEtaS, planEtaRefresh, type EtaBase, type EtaFriendInput, type EtaView } from '@crewmap/shared/etaRefresh';
import { applyPlaceSharing, arrivalCrews, placeFromWire, type ArrivalSubscription, type CrewPlaceTarget, type Place } from '@crewmap/shared/places';
import { CircleManager, codeRelays, invitesKey } from './circle';
import { chatDb, kvGet, kvSet } from './db';
import { hasMapboxToken, matrixFrom } from './mapbox';
import { loadCrewBias, setCrewBias } from './etaTruth';
import { DRIVE_SAMPLES_KEY } from './tracking';
import { crewBiasOf, fitClassModels, sampleObs, type DriveSample } from '@crewmap/shared/navigation';
import { Network } from './network';
import { useAsks, withOnceShares } from './asksStore';
import { useApp, type AppFriendAggs, type CrewInfo, type FriendView, type Profile } from './store';

const STORAGE_KEY = 'crews.v2';
/** Received leaderboard aggregates, by sender (D57). */
const AGG_KEY = 'statsAgg.v1';

interface Crew {
  circle: CircleManager;
  net: Network;
}

/** Which crews may carry a message kind (sender side) and which incoming ones we accept. */
function kindAllowed(kind: Kind, pol: SharingPolicy): boolean {
  if (kind === 'emote' || kind === 'quip' || kind === 'quip-blob') return pol.emotes;
  if (kind === 'chat') return chatAllowed(pol);
  if (kind === 'arrival') return pol.places;
  if (kind === 'check-in') return pol.checkIn === true;
  if (kind === 'hazards' || kind === 'pois') return pol.location !== 'hidden';
  if (isCompanionKind(kind)) return companionKindAllowed(kind, pol);
  if (isMemoryKind(kind)) return memoryKindAllowed(kind, pol);
  return true;
}

/** Merge one crew's view of a friend into another's (most permissive data wins). */
export function mergeFriend(a: FriendView | undefined, b: FriendView): FriendView {
  if (!a) return b;
  const statKeys = (p: Profile) => Object.values(p.stats ?? {}).reduce((n, s) => n + Object.keys(s ?? {}).length, 0);
  const profile = statKeys(b.profile) > statKeys(a.profile) ? { ...a.profile, ...b.profile } : { ...b.profile, ...a.profile };
  return {
    profile,
    presence: mergePresence<FriendPresence>(a.presence, b.presence),
    paused: a.paused && b.paused,
    etaS: a.etaS ?? b.etaS,
    routeM: a.routeM ?? b.routeM,
    isOwner: a.isOwner || b.isOwner,
    crews: [...new Set([...a.crews, ...b.crews])],
  };
}

/**
 * All of this phone's crews (D26): one CircleManager + Network (own epoch keys, Yjs doc, Nostr topics) per crew,
 * one shared device mailbox, and a facade with the single-network shape tracking / hazards / emotes use. Every
 * outgoing path passes through the target crew's sharing policy; friends in several crews are merged by deviceId.
 */
export class Crews {
  private readonly crews = new Map<string, Crew>();
  private order: string[] = [];
  private sharing: Record<string, SharingPolicy> = {};
  /** Per-friend overrides (D52), applied in every crew that carries that friend. */
  private overrides: Record<string, UserOverride> = {};
  private mailbox: Mailbox | null = null;
  private running = false;
  private foreground = false;
  private readonly demandListeners = new Set<(viewer: string) => void>();
  private readonly handlers = new Map<Kind, Set<CrewHandler>>();
  private readonly deliveryHandlers = new Set<(r: DeliveryReport) => void>();
  private readonly docListeners = new Set<() => void>();
  private readonly attached = new Map<string, (() => void)[]>();
  private readonly etaBase = new Map<string, EtaBase>();
  private readonly etaRouteM = new Map<string, number>();
  private etaCallAt = 0;
  private etaInFlight = false;
  /** Called when a crew's policy changes, so the engine can re-publish places / profile / presence. */
  onPolicyChange: (crewId: string) => void = () => undefined;

  constructor(
    readonly me: DeviceIdentity,
    readonly pool: RelayPool,
    private readonly relays: () => string[] = () => DEFAULT_PUBLIC_RELAYS,
  ) {}

  // --- lifecycle --------------------------------------------------------------------------------------------------

  /**
   * Loads every crew; migrates the single-circle layout on first run (see migrateCrewStorage) and, once, the old
   * global sharing settings into per-crew policies / per-friend overrides (migrateSharingGlobals, D52).
   */
  async load(legacy: LegacySharingSettings | null = null): Promise<void> {
    const v2 = await kvGet<CrewStorageV2 | null>(STORAGE_KEY, null);
    const v1: CrewStorageV1 = v2 ? {} : { circleId: await kvGet<string | null>('circleId', null), invites: await kvGet<StoredInviteV1[]>('invites', []) };
    const st = migrateSharingGlobals(migrateCrewStorage(v1, v2), legacy);
    if (!v2) {
      for (const [id, inv] of Object.entries(st.invites)) await kvSet(invitesKey(id), inv);
    }
    this.sharing = Object.fromEntries(Object.entries(st.sharing).map(([k, v]) => [k, normalizePolicy(v)]));
    this.overrides = { ...(st.overrides ?? {}) };
    for (const id of st.circles) {
      const c = this.makeCrew();
      await c.circle.load(id);
      if (c.circle.state) this.adopt(c);
    }
    await this.save();
    this.publishState();
  }

  get count(): number {
    return this.crews.size;
  }

  get ids(): string[] {
    return [...this.order];
  }

  manager(id: string): CircleManager | null {
    return this.crews.get(id)?.circle ?? null;
  }

  network(id: string): Network | null {
    return this.crews.get(id)?.net ?? null;
  }

  /** Mailbox, invites and every crew's router. */
  async start(): Promise<void> {
    this.running = true;
    void loadCrewBias();
    if (Object.keys(useApp.getState().friendAggs).length === 0) useApp.getState().set({ friendAggs: await kvGet<AppFriendAggs>(AGG_KEY, {}) });
    this.mailbox?.stop();
    this.mailbox = new Mailbox(
      this.pool,
      this.relays,
      this.me,
      (circleId, ops) => void this.crews.get(circleId)?.circle.absorb(ops),
      (circleId, from, fromSeq) => void this.crews.get(circleId)?.circle.answerLogRequest(from, fromSeq),
    );
    // Membership mailbox: replay from the last session (1 h overlap), capped at 30 days.
    const nowS = Math.floor(Date.now() / 1000);
    const lastMailbox = await kvGet<number>('lastOnline:mailbox', 0);
    this.mailbox.start(Date.now(), Math.max(nowS - 30 * 86_400, lastMailbox - 3600));
    void kvSet('lastOnline:mailbox', nowS);
    for (const c of this.crews.values()) await this.startCrew(c);
  }

  stop(): void {
    this.running = false;
    this.mailbox?.stop();
    this.mailbox = null;
    for (const [id, c] of this.crews) {
      this.detach(id);
      c.net.stop();
      c.circle.stop();
    }
  }

  async catchUp(): Promise<void> {
    await Promise.all([...this.crews.values()].map((c) => c.net.catchUp()));
  }

  get started(): boolean {
    return this.running;
  }

  // --- viewer demand (protocol 4) ---------------------------------------------------------------------------------

  /** Whether anyone in any crew has the app open right now (older builds always count as watching). */
  watched(): boolean {
    for (const c of this.crews.values()) if (c.net.demand?.watched()) return true;
    return false;
  }

  /** My app is open (true) or not: tells every crew, and every crew started later. */
  setForeground(open: boolean): void {
    this.foreground = open;
    for (const c of this.crews.values()) c.net.demand?.setForeground(open);
  }

  /** A friend just opened the app (from "nobody watching"). */
  onDemand(cb: (viewer: string) => void): () => void {
    this.demandListeners.add(cb);
    return () => this.demandListeners.delete(cb);
  }

  applyTransportSettings(): void {
    for (const c of this.crews.values()) c.net.applyTransportSettings();
  }

  async rotateIfStale(): Promise<void> {
    for (const c of this.crews.values()) await c.circle.rotateIfStale();
  }

  private makeCrew(): Crew {
    const circle = new CircleManager(this.me, this.pool, () => this.mailbox, this.relays);
    const net = new Network(this.me, circle, this.pool, () => this.policy(circle.state?.circleId ?? ''), () => this.overrides, () => this.refreshFriends());
    return { circle, net };
  }

  private adopt(c: Crew): string {
    const id = c.circle.state!.circleId;
    this.crews.set(id, c);
    if (!this.order.includes(id)) this.order.push(id);
    this.sharing[id] ??= { ...DEFAULT_SHARING };
    c.circle.onChange((st) => {
      if (!st) void this.drop(id);
      else this.publishState();
    });
    return id;
  }

  private async startCrew(c: Crew): Promise<void> {
    if (!this.running || !c.circle.state) return;
    await c.circle.startNetwork();
    await c.net.start();
    const id = c.circle.state.circleId;
    this.attach(id, c);
    const demand = c.net.demand;
    if (demand) {
      demand.setForeground(this.foreground);
      this.attached.get(id)?.push(demand.onDemand((v) => this.demandListeners.forEach((l) => l(v))));
    }
    const aggs = c.net.aggs;
    if (aggs) {
      this.attached.get(id)?.push(aggs.onAgg((s, a, eb) => {
        setCrewBias(s, eb);
        this.onAgg(s, a);
      }));
      this.pushAggs(id);
    }
    const me = useApp.getState().me;
    if (me) c.net.writeProfile({ ...me, wake: platform.wake.endpoint() });
  }

  private attach(id: string, c: Crew): void {
    const r = c.net.router;
    if (!r || this.attached.has(id)) return;
    const offs: (() => void)[] = [];
    for (const [kind, hs] of this.handlers) offs.push(r.on(kind, (m) => this.dispatch(id, kind, m, hs)));
    for (const l of this.docListeners) offs.push(c.net.doc.onChange(l));
    r.onDelivery((d) => {
      for (const h of this.deliveryHandlers) h(d);
    });
    this.attached.set(id, offs);
  }

  private detach(id: string): void {
    for (const o of this.attached.get(id) ?? []) o();
    this.attached.delete(id);
  }

  private dispatch(crewId: string, kind: Kind, m: Incoming, hs: Set<CrewHandler>): void {
    // Symmetric: apply crew policy + per-friend override so granted per-friend overrides work in both directions.
    const pol = this.effective(crewId, m.sender);
    if (!kindAllowed(kind, pol) && kind !== 'hazards' && kind !== 'pois') return;
    for (const h of hs) h(m, crewId);
  }

  private async drop(id: string): Promise<void> {
    const c = this.crews.get(id);
    if (!c) return;
    this.detach(id);
    c.net.stop();
    c.circle.stop();
    this.crews.delete(id);
    this.order = this.order.filter((x) => x !== id);
    delete this.sharing[id];
    await chatDb.deleteThread(crewThread(id)).catch(() => undefined);
    if (useApp.getState().crewFilter === id) useApp.getState().set({ crewFilter: null });
    await this.save();
    this.refreshFriends();
  }

  private async save(): Promise<void> {
    const v2: CrewStorageV2 = { circles: this.order, invites: {}, sharing: this.sharing, overrides: this.overrides, ver: SHARING_STORAGE_VER };
    await kvSet(STORAGE_KEY, v2);
  }

  // --- crew management --------------------------------------------------------------------------------------------

  async create(name: string, myName: string, opts: { checkIn?: boolean } = {}): Promise<string> {
    const c = this.makeCrew();
    await c.circle.create(name, myName);
    const id = this.adopt(c);
    if (opts.checkIn !== undefined) this.sharing[id] = { ...this.policy(id), checkIn: opts.checkIn };
    await this.save();
    await this.startCrew(c);
    this.refreshFriends();
    this.onPolicyChange(id);
    this.pushAggs(id);
    return id;
  }

  async join(link: string, myName: string, opts: { checkIn?: boolean } = {}): Promise<string> {
    const c = this.makeCrew();
    await c.circle.join(link, myName);
    const id = c.circle.state!.circleId;
    const existing = this.crews.get(id);
    if (existing) return id;
    this.adopt(c);
    if (opts.checkIn !== undefined) this.sharing[id] = { ...this.policy(id), checkIn: opts.checkIn };
    await this.save();
    await this.startCrew(c);
    this.refreshFriends();
    this.onPolicyChange(id);
    this.pushAggs(id);
    return id;
  }

  /**
   * Short code → invite link (D34), then the caller continues with the normal link join. Throws 'bad code',
   * 'code locked' (5 misses → 60 s) or 'wrong code'. Malformed input does not count as an attempt.
   */
  async resolveCode(raw: string): Promise<string> {
    const code = normaliseJoinCode(raw);
    if (!code) throw new Error('bad code');
    const lock = await kvGet<CodeLockout>('joinCodeLockout', NO_LOCKOUT);
    if (lockoutRemainingMs(lock, Date.now()) > 0) throw new Error('code locked');
    // argon2id runs synchronously on the JS thread: let the spinner paint first.
    await new Promise((r) => setTimeout(r, 50));
    const link = await resolveJoinCode(this.pool, codeRelays(this.relays()), code);
    await kvSet('joinCodeLockout', recordCodeAttempt(lock, !!link, Date.now()));
    if (!link) throw new Error('wrong code');
    return link;
  }

  /** Leave: admins (not the owner) remove themselves so keys rotate for the rest; then forget locally. */
  async leave(id: string): Promise<void> {
    const c = this.crews.get(id);
    if (!c) return;
    const st = c.circle.state;
    try {
      if (st && c.circle.isAdmin && st.ownerId !== this.me.deviceId) await c.circle.remove(this.me.deviceId);
    } catch {
      // best effort
    }
    await c.circle.forget();
    await this.drop(id);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.crews.get(id)?.circle.rename(name);
  }

  policy(id: string): SharingPolicy {
    return this.sharing[id] ?? DEFAULT_SHARING;
  }

  async setPolicy(id: string, p: Partial<SharingPolicy>): Promise<void> {
    if (!this.crews.has(id)) return;
    this.sharing[id] = { ...this.policy(id), ...p };
    await this.save();
    this.publishState();
    this.onPolicyChange(id);
    this.pushAggs(id);
  }

  /** What one friend may see through one crew: their override ?? that crew's policy (D52). */
  effective(crewId: string, friend: string): SharingPolicy {
    return resolveShare(this.policy(crewId), this.overrides[friend]);
  }

  /** Set (or with every field unset, clear) a friend's override; re-publishes like a policy change. */
  async setOverride(friend: string, ov: UserOverride): Promise<void> {
    const clean = cleanOverride(ov);
    if (clean) this.overrides[friend] = clean;
    else delete this.overrides[friend];
    await this.save();
    this.publishState();
    this.onPolicyChange('');
    for (const cid of this.order) this.pushAggs(cid);
  }

  setFilter(id: string | null): void {
    useApp.getState().set({ crewFilter: id && this.crews.has(id) ? id : null });
    this.refreshFriends();
  }

  // --- store ------------------------------------------------------------------------------------------------------

  focused(): CircleState | null {
    const f = useApp.getState().crewFilter;
    const id = f && this.crews.has(f) ? f : this.order[0];
    return id ? (this.crews.get(id)?.circle.state ?? null) : null;
  }

  private publishState(): void {
    const crews: CrewInfo[] = [];
    for (const id of this.order) {
      const c = this.crews.get(id);
      const st = c?.circle.state;
      if (!c || !st) continue;
      crews.push({ id, name: st.name, ownerId: st.ownerId, epoch: st.epoch, memberIds: [...st.members.keys()], isAdmin: c.circle.isAdmin });
    }
    const f = this.focused();
    useApp.getState().set({
      crews,
      sharing: { ...this.sharing },
      shareOverrides: { ...this.overrides },
      circle: f ? { id: f.circleId, name: f.name, ownerId: f.ownerId, epoch: f.epoch } : null,
    });
  }

  refreshFriends(): void {
    const prev = useApp.getState().allFriends;
    let all: Record<string, FriendView> = {};
    for (const id of this.order) {
      const views = this.crews.get(id)?.net.friendViews() ?? {};
      for (const [fid, v] of Object.entries(views)) all[fid] = mergeFriend(all[fid], v);
    }
    for (const [fid, v] of Object.entries(all)) all[fid] = { ...v, etaS: prev[fid]?.etaS ?? null, routeM: prev[fid]?.routeM ?? null };
    all = withOnceShares(all, useAsks.getState().entries, Date.now());
    useApp.getState().set({ allFriends: all, friends: this.filtered(all) });
    this.publishState();
  }

  private filtered(all: Record<string, FriendView>): Record<string, FriendView> {
    const f = useApp.getState().crewFilter;
    if (!f) return all;
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v.crews.includes(f)));
  }

  private patchFriend(id: string, p: Partial<FriendView>): void {
    const all = useApp.getState().allFriends;
    const cur = all[id];
    if (!cur) return;
    const next = { ...all, [id]: { ...cur, ...p } };
    useApp.getState().set({ allFriends: next, friends: this.filtered(next) });
  }

  // --- outgoing (policy-enforced) ---------------------------------------------------------------------------------

  // --- leaderboard aggregates (protocol 9, D57) ---------------------------------------------------------------------

  private myAggs: AggSet | null = null;

  /** My full aggregates; each crew seals a copy per friend with only the groups that friend may see. */
  publishStatsAgg(aggs: AggSet): void {
    this.myAggs = aggs;
    for (const id of this.order) this.pushAggs(id);
    void this.refreshEtaBias();
  }

  /** My own road-group ETA multipliers from my drive samples, sent with the stats aggregates (D60). */
  private async refreshEtaBias(): Promise<void> {
    const obs = sampleObs(await kvGet<DriveSample[]>(DRIVE_SAMPLES_KEY, []));
    if (obs.length === 0) return;
    const eb = crewBiasOf(fitClassModels(obs));
    for (const c of this.crews.values()) c.net.aggs?.setEtaBias(eb);
  }

  private pushAggs(crewId: string): void {
    const c = this.crews.get(crewId);
    const full = this.myAggs;
    if (!c?.net.aggs || !full) return;
    c.net.aggs.publish((peer) => {
      const pol = this.effective(crewId, peer);
      if (!pol.stats) return null;
      const out: AggSet = {};
      for (const [p, a] of Object.entries(full) as [Period, NonNullable<AggSet[Period]>][]) out[p] = restrictAgg(a, (g) => statsAllowed(pol, g));
      return out;
    });
  }

  private onAgg(sender: string, aggs: AggSet): void {
    const cur = useApp.getState().friendAggs;
    const next = { ...cur, [sender]: { t: Date.now(), a: aggs } };
    useApp.getState().set({ friendAggs: next });
    void kvSet(AGG_KEY, next);
  }

  /** My full profile into every crew doc, reduced per crew policy. */
  publishProfile(p: Partial<Profile>): void {
    const cur = useApp.getState().me;
    const next: Profile = {
      deviceId: this.me.deviceId,
      name: cur?.name ?? 'Me',
      avatar: cur?.avatar ?? DEFAULT_AVATAR,
      car: cur?.car ?? DEFAULT_CAR,
      ...cur,
      ...p,
    };
    useApp.getState().set({ me: next });
    for (const c of this.crews.values()) c.net.writeProfile(next);
  }

  async publishPresence(p: Presence): Promise<void> {
    await Promise.all([...this.crews.values()].map((c) => c.net.publishPresence(p).catch(() => undefined)));
  }

  /** Every crew as a place-sharing target (its doc map + places policy). */
  private placeTargets(): (CrewPlaceTarget & { isMember(id: string): boolean })[] {
    return [...this.crews].map(([id, c]) => ({ id, allowsPlaces: this.policy(id).places, places: c.net.doc.places, isMember: (m: string) => c.net.has(m) }));
  }

  /** Crews that may carry an arrival about `placeId` to `to` (place in that crew doc, policy allows places). */
  arrivalCrewsFor(placeId: string, to: string): string[] {
    return arrivalCrews(placeId, to, this.placeTargets());
  }

  private allowedCrews(kind: Kind, to?: string): Crew[] {
    return this.order
      .map((id) => this.crews.get(id))
      .filter((c): c is Crew => {
        const id = c?.circle.state?.circleId ?? '';
        // A friend set to Hidden gets no arrival / departure / driving-home either (they reveal where I am).
        if (to && kind === 'arrival' && this.overrides[to]?.location === 'hidden') return false;
        if (to && kind === 'check-in' && !checkInAllowed(this.effective(id, to), this.overrides[to])) return false;
        return !!c && !!c.net.router && (!to || c.net.has(to)) && kindAllowed(kind, to ? this.effective(id, to) : this.policy(id));
      });
  }

  /** Crew-wide message into one crew only (crew chat), if its policy allows the kind. */
  async broadcastIn(crewId: string, kind: Kind, payload: Uint8Array): Promise<string> {
    const c = this.crews.get(crewId);
    if (!c?.net.router || !kindAllowed(kind, this.policy(crewId))) return '';
    return c.net.router.broadcast(kind, payload);
  }

  /** Someone would get my check-in alerts (D66). Config only: true while the radio governor has the routers closed. */
  checkInConfigured(): boolean {
    for (const [id, c] of this.crews)
      for (const m of c.circle.state?.members.keys() ?? []) {
        if (m === this.me.deviceId) continue;
        const pol = this.effective(id, m);
        if (kindAllowed('check-in', pol) && checkInAllowed(pol, this.overrides[m])) return true;
      }
    return false;
  }

  /** Crewmates (deduped over crews) who get my safety check-in alerts (D66). */
  checkInRecipients(): string[] {
    const out = new Set<string>();
    for (const c of this.crews.values())
      for (const m of c.circle.state?.members.keys() ?? []) if (m !== this.me.deviceId && !out.has(m) && this.companionAllowed('check-in', m)) out.add(m);
    return [...out];
  }

  /** Whether some crew shared with `to` may carry this companion kind (D31). */
  companionAllowed(kind: Kind, to: string): boolean {
    return this.allowedCrews(kind, to).length > 0;
  }

  /**
   * Companion message to one friend (D31): carried by the first crew we share with them whose policy allows the kind;
   * `build` gets THAT crew's policy with the friend's override (null = nothing may be sent); box-sealed to the recipient.
   */
  async companionSend(to: string, kind: Kind, build: (pol: SharingPolicy) => unknown): Promise<boolean> {
    const c = this.allowedCrews(kind, to)[0];
    const id = c?.circle.state?.circleId;
    const pk = c?.circle.state?.members.get(to)?.boxPk;
    if (!c?.net.router || !id || !pk) return false;
    const value = build(this.effective(id, to));
    if (value === null || value === undefined) return false;
    await c.net.router.sendTo(to, kind, sealJson(unb64(pk), value));
    return true;
  }

  /** A member's public box key (1:1 chat sealing), from any crew we share with them. */
  boxPkOf(deviceId: string): string | null {
    for (const c of this.crews.values()) {
      const m = c.circle.state?.members.get(deviceId);
      if (m) return m.boxPk;
    }
    return null;
  }

  /** Router-shaped facade; null until at least one crew is online. */
  get router(): CrewRouter | null {
    if (![...this.crews.values()].some((c) => c.net.router)) return null;
    return this.routerFacade;
  }

  private readonly routerFacade: CrewRouter = ((self: Crews): CrewRouter => ({
    on: (kind, h) => {
      let hs = this.handlers.get(kind);
      if (!hs) {
        hs = new Set();
        this.handlers.set(kind, hs);
        for (const [id, c] of this.crews) {
          const set = hs;
          const off = c.net.router?.on(kind, (m) => this.dispatch(id, kind, m, set));
          if (off) this.attached.get(id)?.push(off);
        }
      }
      hs.add(h);
      return () => hs.delete(h);
    },
    /** One crew carries it: the first we share with `to` whose policy allows this kind. */
    sendTo: async (to, kind, payload, via) => {
      const c = this.allowedCrews(kind, to).find((x) => !via || via.includes(x.circle.state?.circleId ?? ''));
      return c?.net.router ? c.net.router.sendTo(to, kind, payload) : '';
    },
    broadcast: async (kind, payload) => {
      const ids = await Promise.all(this.allowedCrews(kind).map((c) => c.net.router!.broadcast(kind, payload)));
      return ids[0] ?? '';
    },
    onDelivery: (h) => {
      this.deliveryHandlers.add(h);
    },
    get stats() {
      return self.statsSum();
    },
  }))(this);

  /** Transport health over all crews (the relay pool is shared, so its sockets count once). */
  connectivity(): { started: boolean; queued: number; relaysUp: number; relaysTotal: number } {
    let started = false;
    let queued = 0;
    let relaysUp = 0;
    let relaysTotal = 0;
    for (const c of this.crews.values()) {
      const k = c.net.connectivity();
      started ||= k.started;
      queued += k.queued;
      relaysUp = Math.max(relaysUp, k.relaysUp);
      relaysTotal = Math.max(relaysTotal, k.relaysTotal);
    }
    return { started, queued, relaysUp, relaysTotal };
  }

  /** Summed transport counters over all crews (developer screen). */
  statsSum(): RouterStats {
    const out: RouterStats = { sentDirect: 0, sentNostr: 0, sentRelay: 0, received: 0, rejected: 0, wakes: 0, bytesOut: 0 };
    for (const c of this.crews.values()) {
      const st = c.net.router?.stats;
      if (st) for (const k of Object.keys(out) as (keyof RouterStats)[]) out[k] += st[k];
    }
    return out;
  }

  /** Doc-shaped facade over every crew doc. */
  readonly doc: CrewDocView = {
    sharedPlaces: () => {
      const seen = new Map<string, Place>();
      for (const c of this.crews.values()) for (const p of c.net.doc.sharedPlaces()) if (!seen.has(p.id)) seen.set(p.id, p);
      return [...seen.values()];
    },
    places: { get: (id) => this.firstOf((c) => { const w = c.net.doc.places.get(id); return w ? placeFromWire(w) : undefined; }) },
    profile: (id) => this.firstOf((c) => c.net.doc.profile(id) ?? undefined) ?? null,
    /** My shared places only enter docs of crews whose policy shares places. */
    putPlace: (p) => {
      applyPlaceSharing(p, this.placeTargets());
    },
    removePlace: (id) => {
      for (const c of this.crews.values()) c.net.doc.removePlace(id);
    },
    subscriptions: {
      values: () => {
        const seen = new Map<string, ArrivalSubscription>();
        for (const c of this.crews.values()) for (const [k, s] of c.net.doc.subscriptions) if (!seen.has(k)) seen.set(k, s);
        return seen.values();
      },
      set: (id, s) => {
        for (const c of this.crews.values()) if (c.net.has(s.target) || c.net.has(s.subscriber)) c.net.doc.subscriptions.set(id, s);
      },
      delete: (id) => {
        for (const c of this.crews.values()) c.net.doc.subscriptions.delete(id);
      },
    },
    reports: {
      get: (id) => this.firstOf((c) => c.net.doc.reports.get(id)),
      set: (id, r) => {
        for (const [cid, c] of this.crews) if (r.by !== this.me.deviceId || this.policy(cid).location !== 'hidden') c.net.doc.reports.set(id, r);
      },
    },
    allReports: () => {
      const seen = new Map<string, FriendReport>();
      for (const c of this.crews.values()) for (const r of c.net.doc.allReports()) if (!seen.has(r.id)) seen.set(r.id, r);
      return [...seen.values()];
    },
    pruneReports: (alive) => {
      for (const c of this.crews.values()) c.net.doc.pruneReports(alive);
    },
    onChange: (cb) => {
      this.docListeners.add(cb);
      const offs = [...this.crews.entries()].map(([id, c]) => {
        const off = c.net.doc.onChange(cb);
        this.attached.get(id)?.push(off);
        return off;
      });
      return () => {
        this.docListeners.delete(cb);
        for (const o of offs) o();
      };
    },
    config: {
      get: (k) => this.focusedCrew()?.net.doc.config.get(k),
      set: (k, v) => this.focusedCrew()?.net.doc.config.set(k, v),
    },
  };

  /** Focused crew's membership (hazard config signer = its owner). */
  readonly circle = ((self: Crews) => ({
    get state(): CircleState | null {
      return self.focused();
    },
  }))(this);

  private focusedCrew(): Crew | null {
    const st = this.focused();
    return st ? (this.crews.get(st.circleId) ?? null) : null;
  }

  private firstOf<T>(f: (c: Crew) => T | undefined): T | undefined {
    for (const id of this.order) {
      const c = this.crews.get(id);
      const v = c ? f(c) : undefined;
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** Friend card open: that friend's drive time refreshes at once (D45). */
  etaFocus: string | null = null;

  /**
   * F3 / D45: routed ETA + distance from me to friends, demand-driven (`planEtaRefresh`): nothing when no surface
   * shows them, never re-queried while both are still, staleness scaled by distance while someone moves. One Matrix
   * call covers all due friends; between calls the shown number is dead-reckoned from P2P positions.
   */
  async refreshEtas(ctx: { view: EtaView; navEtaToMe?: ReadonlyMap<string, number> }): Promise<void> {
    const { fix, allFriends, friends: visibleFriends } = useApp.getState();
    if (!fix || ctx.view === 'off' || !hasMapboxToken() || this.etaInFlight) return;
    const now = Date.now();
    const inputs: EtaFriendInput[] = [];
    const byId = new Map<string, FriendPresence>();
    for (const f of Object.values(allFriends)) {
      const p = f.presence;
      if (!p || f.paused) continue;
      byId.set(p.deviceId, p);
      const nav = ctx.navEtaToMe?.get(p.deviceId);
      inputs.push({ id: p.deviceId, pos: p, spd: p.spd, shown: !!visibleFriends[p.deviceId], ...(nav !== undefined ? { navEtaToMe: nav } : {}) });
    }
    const due = planEtaRefresh({ now, view: ctx.view, me: fix, mySpd: fix.speed ?? null, friends: inputs, base: this.etaBase, lastCallAt: this.etaCallAt, focusId: this.etaFocus });
    if (due.length) {
      const targets = due.map((id) => byId.get(id)!);
      this.etaCallAt = now;
      this.etaInFlight = true;
      try {
        const m = await matrixFrom(fix, targets);
        targets.forEach((p, i) => {
          const me = { lat: fix.lat, lng: fix.lng };
          this.etaBase.set(p.deviceId, { at: now, etaS: m.durationS[i] ?? null, straightM: haversineM(me, p), me, friend: { lat: p.lat, lng: p.lng } });
          if (m.distanceM[i] != null) this.etaRouteM.set(p.deviceId, m.distanceM[i]!);
        });
      } catch {
        // Offline or quota: keep the last values.
      } finally {
        this.etaInFlight = false;
      }
    }
    const cur = useApp.getState().allFriends;
    let next: Record<string, FriendView> | null = null;
    for (const f of inputs) {
      const etaS = displayEtaS(this.etaBase.get(f.id), fix, f.pos, now, f.navEtaToMe);
      const routeM = this.etaRouteM.get(f.id) ?? null;
      const was = cur[f.id];
      if (was && (was.etaS !== etaS || was.routeM !== routeM)) {
        next ??= { ...cur };
        next[f.id] = { ...was, etaS, routeM };
      }
    }
    if (next) useApp.getState().set({ allFriends: next, friends: this.filtered(next) });
  }
}

type RouterStats = Router['stats'];

/** Incoming handler; `crewId` is the crew whose router (epoch key) opened the message. */
export type CrewHandler = (m: Incoming, crewId: string) => void;

export interface CrewRouter {
  on(kind: Kind, h: CrewHandler): () => void;
  /** `via`: only these crews may carry it. */
  sendTo(to: string, kind: Kind, payload: Uint8Array, via?: string[]): Promise<string>;
  broadcast(kind: Kind, payload: Uint8Array): Promise<string>;
  onDelivery(h: (r: DeliveryReport) => void): void;
  readonly stats: RouterStats;
}

export interface CrewDocView {
  sharedPlaces(): Place[];
  places: { get(id: string): Place | undefined };
  profile(id: string): Profile | null;
  putPlace(p: Place): void;
  removePlace(id: string): void;
  subscriptions: {
    values(): IterableIterator<ArrivalSubscription> | MapIterator<ArrivalSubscription>;
    set(id: string, s: ArrivalSubscription): void;
    delete(id: string): void;
  };
  reports: { get(id: string): FriendReport | undefined; set(id: string, r: FriendReport): void };
  allReports(): FriendReport[];
  pruneReports(alive: (r: FriendReport) => boolean): void;
  onChange(cb: () => void): () => void;
  config: { get(k: 'hazards'): SignedHazardConfig | undefined; set(k: 'hazards', v: SignedHazardConfig): void };
}
