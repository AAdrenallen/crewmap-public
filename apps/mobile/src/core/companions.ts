import { create } from 'zustand';
import {
  fromUtf8,
  livePresenceFor,
  openJson,
  parseRouteShare,
  peerSupports,
  type Capability,
  type DeviceIdentity,
  type Incoming,
  type Kind,
  type Presence,
} from '@crewmap/p2p';
import {
  adoptDest,
  allArrived,
  applyOp,
  atDestination,
  changeDest,
  groupSummary,
  markArrived,
  BatteryWatch,
  CompanionCues,
  consumeOnce,
  etaShareDue,
  heard,
  inviteOp,
  liveTargets,
  livePeriodMs,
  LocateLimiter,
  newSession,
  parseEtaShare,
  parseOp,
  regroupPoint,
  relation,
  routeRef,
  sessionFromInvite,
  thinRoute,
  tick,
  type DriveAlongOp,
  type DriveAlongSession,
  type EtaShare,
  type GroupDest,
  type GroupSummary,
  type Relation,
  applyConvoy,
  DRIVE_ALONG,
  ConvoyCallouts,
  convoyCrew,
  convoyLeader,
  convoyOp,
  convoyOrderMap,
  ConvoyTracker,
  followLine,
  gapLabel,
  lightsBetween,
  neighbours,
  regroupAudience,
  RegroupWatch,
  type ConvoyStanding,
  type GapLabel,
} from '@crewmap/shared/companions';
import type { LatLng } from '@crewmap/shared/geo';
import { currentRouteQuery, excludeList, type NavRoute } from '@crewmap/shared/navigation';
import { lang, t, tIn, type Lang } from '@crewmap/shared/i18n';
import { formatClock, formatDistance } from '@crewmap/shared/units';
import { budgetLevel } from './apiBudget';
import { isConvoyMuted, loadConvoyPrefs, useConvoyPrefs } from './convoyPrefs';
import { directionsQuery } from './mapbox';
import { getRouteOptions } from './nav';
import { DRIVE_UX } from '../ui/drive/driveUx';
import type { Crews } from './crews';
import { isMuted } from './friendPrefs';
import { say, voiceLang } from './nav';
import { notifyMode } from '../ui/drive/driveUx';
import { friendContextNow } from './friendContext';
import { notify } from './notify';
import { useApp } from './store';

/** A pending invite from someone else (accept / decline / ignore = let it lapse). */
export interface DriveAlongInvite {
  from: string;
  op: Extract<DriveAlongOp, { op: 'invite' }>;
  at: number;
}

export interface CompanionRoute {
  line: LatLng[];
  dest: string;
  eta: number | null;
}

/** Low-rate state: session, invites, shared routes, regroup point, live ETA shares. */
interface DriveAlongState {
  session: DriveAlongSession | null;
  invites: DriveAlongInvite[];
  routes: Record<string, CompanionRoute>;
  regroup: { name: string; lat: number; lng: number } | null;
  /** Live ETA shares received, per friend. */
  etaIn: Record<string, EtaShare>;
  /** Friends I am sharing my live ETA with. */
  etaOut: string[];
  /** Group drive: who arrived and when, shown once everyone is in or the drive ended. */
  summary: GroupSummary | null;
  /** Convoy (D65): order number per member (1 = front), changes only when the order does (map badges read it). */
  convoyOrder: Record<string, number>;
  /** Convoy regroup alert for the non-interactive banner. */
  convoyAlert: { id: string; text: string; at: number } | null;
  /** Leader whose route I adopted or dismissed (the follow prompt is not offered again for them). */
  followDone: string | null;
}

export const useDriveAlong = create<DriveAlongState>(() => ({
  convoyOrder: {},
  convoyAlert: null,
  followDone: null,
  summary: null,
  session: null,
  invites: [],
  routes: {},
  regroup: null,
  etaIn: {},
  etaOut: [],
}));

export interface LiveCompanion {
  lat: number;
  lng: number;
  spd: number | null;
  hdg: number | null;
  /** Their own navigation ETA (ms epoch) when they share one. */
  eta: number | null;
  t: number;
  receivedAt: number;
  rel: Relation | null;
}

/** Convoy view (D65): standings along the leader's line and each member's gap relative to me. */
export interface ConvoyView {
  leader: string;
  rows: ConvoyStanding[];
  /** Signed gap to me (> 0 ahead): metres and seconds along the route, signals between us when known. */
  rel: Record<string, { m: number; s: number; lights: number | null }>;
}

/** High-rate state (1–2 s): read by the companion strip and edge blips only, never by the map tree (D28). */
export const useCompanionLive = create<{ live: Record<string, LiveCompanion>; convoy: ConvoyView | null }>(() => ({ live: {}, convoy: null }));

/** Short gap text: "2 lights", "3 min", "1.0 km". */
export function gapText(l: GapLabel, lang: Lang): string {
  if (l.kind === 'lights') return tIn(lang, l.n === 1 ? 'cv.light1' : 'cv.lightsN', { n: l.n });
  if (l.kind === 'min') return tIn(lang, 'cv.minN', { n: l.n });
  return formatDistance(l.n, lang);
}

export type DriveAlongAvailability = 'ok' | 'old' | 'policy' | 'offline';

const RELATION_EVERY_MS = 2000;
const ROUTE_EVERY_MS = 60_000;
const TICK_MS = 5000;

/**
 * Friend companion features (D31): drive-along sessions with live presence among participants only, shared route
 * lines + regroup point + voice cues; "ask for location"; live ETA shares; friend battery-low alerts; one-shot arrival
 * alerts. Every outgoing message goes through `Crews.companionSend`, i.e. the carrying crew's policy, sealed to one
 * recipient.
 */
export class Companions {
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLiveAt = 0;
  private lastRelAt = 0;
  private lastRouteAt = 0;
  private lastRouteId: string | null = null;
  private parkedSince: number | null = null;
  private readonly cues = new Map<string, CompanionCues>();
  private readonly battery = new Map<string, BatteryWatch>();
  private readonly locate = new LocateLimiter();
  private readonly etaSent = new Map<string, { eta: number; at: number }>();
  private etaSid = '';
  private readonly tracker = new ConvoyTracker();
  private readonly callouts = new Map<string, ConvoyCallouts>();
  private readonly regroupWatch = new Map<string, RegroupWatch>();
  private pendingSay: { text: string; names: string[]; kind: 'guidance' | 'alert'; at: number } | null = null;

  constructor(
    private readonly crews: Crews,
    private readonly me: DeviceIdentity,
    private readonly publishNow: () => Promise<void>,
    /** Route to a group destination and start turn-by-turn (the Navigator's preview + start). */
    private readonly startNav: (dest: GroupDest) => Promise<boolean>,
    /** Start turn-by-turn on a route already fetched (convoy: the leader's line). */
    private readonly startRoute: (dest: GroupDest, route: NavRoute) => void,
  ) {}

  start(): void {
    const r = this.crews.router;
    if (!r || this.offs.length) return;
    void loadConvoyPrefs();
    const on = (kind: Kind, h: (m: Incoming, v: unknown) => void) =>
      r.on(kind, (m) => h(m, openJson(this.me, m.payload)));
    this.offs.push(
      on('drive-along', (m, v) => this.onOp(m.sender, v)),
      on('presence-live', (m, v) => this.onLive(m, v)),
      on('route-share', (m, v) => this.onRoute(m.sender, v)),
      on('loc-request', (m) => void this.onLocateRequest(m.sender)),
      on('eta-share', (m, v) => this.onEta(m.sender, v)),
      r.on('arrival', (m) => this.onArrivalOnce(m)),
      useApp.subscribe((s, prev) => {
        if (s.fix !== prev.fix && s.fix) void this.onFix();
        if (s.driving !== prev.driving) this.parkedSince = s.driving ? null : Date.now();
        if (s.allFriends !== prev.allFriends) this.checkBatteries();
        if (s.nav?.active !== prev.nav?.active && !s.nav?.active) void this.endEtaShares('arrived');
      }),
    );
  }

  stop(): void {
    for (const o of this.offs) o();
    this.offs = [];
    this.setTimer(false);
  }

  // --- availability ----------------------------------------------------------------------------------------------

  /** Whether drive-along (or another companion feature) can reach this friend: app version, then crew policy. */
  availability(
    friendId: string,
    cap: Capability = 'driveAlong',
    kind: Kind = 'drive-along',
  ): DriveAlongAvailability {
    if (!this.crews.router) return 'offline';
    const f = useApp.getState().allFriends[friendId];
    // Unknown (never heard presence) counts as old: an acked op to an old build would only retry until it gives up.
    if (peerSupports(f?.presence, cap) !== true) return 'old';
    if (!this.crews.companionAllowed(kind, friendId)) return 'policy';
    if (kind === 'drive-along' && useApp.getState().settings.ghost) return 'policy';
    return 'ok';
  }

  // --- drive-along -----------------------------------------------------------------------------------------------

  /**
   * Whether `friendId` can be invited to a group drive: 'old' when their app lacks the capability (it is then not
   * offered; a plain drive-along stays possible through `startDriveAlong` without a destination).
   */
  groupAvailability(friendId: string): DriveAlongAvailability {
    const a = this.availability(friendId, 'groupDrive');
    return a === 'ok' ? 'ok' : a;
  }

  /**
   * Start (or extend, when I already host one) a drive-along / group drive with these friends. With `dest` it is a
   * group drive and only friends whose app supports it are invited. Returns who was invited.
   */
  async startDriveAlong(ids: string[], crew: string | null = null, dest: GroupDest | null = null, convoy = false): Promise<string[]> {
    const st = useApp.getState();
    const me = { id: this.me.deviceId, name: st.me?.name ?? '' };
    const ok = ids.filter((id) => (dest ? this.groupAvailability(id) : this.availability(id)) === 'ok');
    if (ok.length === 0) return [];
    const invitees = ok.map((id) => ({ id, name: st.allFriends[id]?.profile.name ?? '' }));
    const now = Date.now();
    let s = useDriveAlong.getState().session;
    if (s && s.owner === me.id) {
      s = applyOp(s, me.id, { ...inviteOp(newSession(s.sid, me, invitees, crew, now), now), sid: s.sid }, now)!;
      if (dest && !s.dest) s = changeDest(s, dest);
      // The re-sent invite carries the convoy, so members already in learn it from the same op.
      if (convoy && dest && !convoyLeader(s)) s = applyConvoy(s, me.id, convoyOp(s, true, me.id, now));
    } else {
      if (s) await this.leaveDriveAlong();
      s = newSession(`da-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, me, invitees, crew, now, dest, convoy && !!dest);
    }
    this.setSession(s);
    const op = inviteOp(s, now);
    // Newcomers get the invite; members already in learn about them through the same op. Declined / gone are left alone.
    await Promise.all(
      Object.entries(s.members)
        .filter(([id, m]) => id !== me.id && (m.state === 'invited' || m.state === 'joined'))
        .map(([id]) => this.crews.companionSend(id, 'drive-along', () => op)),
    );
    this.lastLiveAt = 0;
    void this.onFix();
    return ok;
  }

  /** Accept an invite; for a group drive, also start navigating to the host's destination. Returns false when routing failed. */
  async accept(from: string): Promise<boolean> {
    const inv = useDriveAlong.getState().invites.find((i) => i.from === from);
    if (!inv) return true;
    const cur = useDriveAlong.getState().session;
    if (cur && cur.sid !== inv.op.sid) await this.leaveDriveAlong();
    const now = Date.now();
    this.setSession(sessionFromInvite(inv.op, from, this.me.deviceId, now));
    useDriveAlong.setState((s) => ({ invites: s.invites.filter((i) => i.from !== from) }));
    const op: DriveAlongOp = { v: 1, op: 'accept', sid: inv.op.sid, t: now };
    // Everyone in the session learns I joined (they start sending me their live position).
    const sent = Promise.all(
      [from, ...inv.op.members.map((m) => m.id)]
        .filter((id) => id !== this.me.deviceId)
        .map((id) => this.crews.companionSend(id, 'drive-along', () => op)),
    );
    this.lastLiveAt = 0;
    void this.onFix();
    const routed = inv.op.dest ? await this.startNav(inv.op.dest) : true;
    await sent;
    return routed;
  }

  /** Group drive: the host changed the destination; take it and navigate there. */
  async acceptDest(): Promise<boolean> {
    const s = useDriveAlong.getState().session;
    if (!s?.pendingDest) return true;
    const dest = s.pendingDest.dest;
    this.setSession(adoptDest(s));
    return this.startNav(dest);
  }

  dismissDest(): void {
    const s = useDriveAlong.getState().session;
    if (s?.pendingDest) this.setSession({ ...s, pendingDest: null });
  }

  /** Host: send everyone to a new destination (they get a prompt), and navigate there myself. */
  async changeDestination(dest: GroupDest): Promise<boolean> {
    const s = useDriveAlong.getState().session;
    if (!s || s.owner !== this.me.deviceId) return false;
    const next = changeDest(s, dest);
    this.setSession(next);
    const op: DriveAlongOp = { v: 1, op: 'dest', sid: s.sid, t: Date.now(), dest, rev: next.destRev };
    await Promise.all(
      Object.entries(next.members)
        .filter(([id, m]) => id !== this.me.deviceId && (m.state === 'joined' || m.state === 'invited'))
        .map(([id]) => this.crews.companionSend(id, 'drive-along', () => op)),
    );
    return true;
  }

  dismissSummary(): void {
    useDriveAlong.setState({ summary: null });
  }

  // --- convoy (D65) ----------------------------------------------------------------------------------------------

  /** Host: turn convoy mode on (leader = `leader`, default me) or off. Leader: hand the lead to `leader`. */
  async setConvoy(on: boolean, leader: string = this.me.deviceId): Promise<boolean> {
    const s = useDriveAlong.getState().session;
    if (!s?.dest) return false;
    const op = convoyOp(s, on, leader, Date.now());
    const next = applyConvoy(s, this.me.deviceId, op);
    if (next === s) return false;
    this.onConvoyChange(s, next);
    this.setSession(next);
    await Promise.all(
      Object.entries(next.members)
        .filter(([id, m]) => id !== this.me.deviceId && (m.state === 'joined' || m.state === 'invited'))
        .map(([id]) => this.crews.companionSend(id, 'drive-along', () => op)),
    );
    return true;
  }

  /** Follower: drive the leader's shared line from where I am (one via-constrained Directions call). */
  async followLeader(): Promise<boolean> {
    const s = useDriveAlong.getState().session;
    const leader = s ? convoyLeader(s) : null;
    const st = useApp.getState();
    const line = leader ? useDriveAlong.getState().routes[leader]?.line : undefined;
    if (!s?.dest || !leader || leader === this.me.deviceId || !line || !st.fix) return false;
    if (budgetLevel('directions') === 'off') return false;
    const rest = followLine(line, st.fix);
    const q = rest ? currentRouteQuery(rest, st.fix.heading, excludeList(getRouteOptions())) : null;
    if (!q) return false;
    try {
      const route = (await directionsQuery(q, voiceLang()))[0];
      if (!route) return false;
      this.startRoute(s.dest, route);
      useDriveAlong.setState({ followDone: leader });
      return true;
    } catch {
      return false;
    }
  }

  dismissFollow(): void {
    const s = useDriveAlong.getState().session;
    const leader = s ? convoyLeader(s) : null;
    if (leader) useDriveAlong.setState({ followDone: leader });
  }

  /** Convoy changes seen on this phone: share my route at once when I take the lead, withdraw it when I hand it over. */
  private onConvoyChange(prev: DriveAlongSession, next: DriveAlongSession): void {
    const me = this.me.deviceId;
    const was = convoyLeader(prev) === me;
    const now = convoyLeader(next) === me;
    if (now && !was) {
      this.lastRouteAt = 0;
      this.lastRouteId = null;
      void this.sendRoute(false);
    } else if (was && !now && !next.shareRoute) void this.sendRoute(true);
  }

  private convoyMuted(s: DriveAlongSession): boolean {
    return isConvoyMuted(convoyCrew(s, useApp.getState().crews));
  }

  /** Spoken convoy line, held back while a turn is close (the turn instruction wins); stale lines are dropped. */
  private sayConvoy(text: string, names: string[], kind: 'guidance' | 'alert' = 'guidance'): void {
    const next = useApp.getState().nav?.progress?.next?.distanceM ?? null;
    if (next !== null && next < DRIVE_UX.maneuverQuietM) this.pendingSay = { text, names, kind, at: Date.now() };
    else say(text, kind, names);
  }

  private flushSay(): void {
    const p = this.pendingSay;
    if (!p) return;
    const next = useApp.getState().nav?.progress?.next?.distanceM ?? null;
    if (Date.now() - p.at > 60_000) this.pendingSay = null;
    else if (next === null || next >= DRIVE_UX.maneuverQuietM) {
      this.pendingSay = null;
      say(p.text, p.kind, p.names);
    }
  }

  private clearConvoy(): void {
    this.tracker.setLine(null);
    this.callouts.clear();
    this.regroupWatch.clear();
    this.pendingSay = null;
    if (useCompanionLive.getState().convoy) useCompanionLive.setState({ convoy: null });
    const d = useDriveAlong.getState();
    if (Object.keys(d.convoyOrder).length || d.convoyAlert) useDriveAlong.setState({ convoyOrder: {}, convoyAlert: null });
  }

  /** Standings, map order, gap callouts and regroup alerts (every ~2 s and on each leader route). */
  private updateConvoy(): void {
    const s = useDriveAlong.getState().session;
    const leader = s ? convoyLeader(s) : null;
    if (!s || !leader) return this.clearConvoy();
    const me = this.me.deviceId;
    const st = useApp.getState();
    const nav = st.nav;
    const line = leader === me ? (nav?.active ? nav.route.geometry : null) : (useDriveAlong.getState().routes[leader]?.line ?? null);
    this.tracker.setLine(line, leader);
    const live = useCompanionLive.getState().live;
    // Re-feed the latest positions (a no-op unless the line just changed and the tracks were reset).
    if (st.fix) this.tracker.update(me, { lat: st.fix.lat, lng: st.fix.lng, t: st.fix.t, spd: st.fix.speed });
    for (const [id, c] of Object.entries(live)) this.tracker.update(id, { lat: c.lat, lng: c.lng, t: c.t, spd: c.spd });
    const now = Date.now();
    const fresh = (id: string) => id === me || (!!live[id] && now - live[id]!.receivedAt <= DRIVE_ALONG.staleMs);
    const ids = [me, ...liveTargets(s, me)].filter(fresh);
    const rows = this.tracker.standings(ids, new Set(Object.keys(s.arrived)));
    const rel: ConvoyView['rel'] = {};
    for (const id of ids) {
      if (id === me) continue;
      const r = this.tracker.relative(me, id);
      if (!r) continue;
      // "N lights": signals on my own route between us, when both of us are on it.
      const g = live[id]?.rel?.alongGapM ?? null;
      const myAlong = nav?.active ? (nav.progress?.alongM ?? null) : null;
      const lights = g !== null && myAlong !== null ? lightsBetween(nav!.route.signalsAlongM, myAlong, myAlong + g) : null;
      rel[id] = { m: r.m, s: r.s, lights };
    }
    useCompanionLive.setState({ convoy: { leader, rows, rel } });
    const order = convoyOrderMap(rows);
    if (JSON.stringify(order) !== JSON.stringify(useDriveAlong.getState().convoyOrder)) useDriveAlong.setState({ convoyOrder: order });

    const muted = this.convoyMuted(s);
    const moving = !!nav?.active || st.driving;
    const vl = voiceLang();
    const name = (id: string) => s.members[id]?.name ?? '';
    // Gap callouts about my neighbours only (the car ahead of me, the car behind me).
    const nb = neighbours(rows, me);
    for (const [dir, n] of [['ahead', nb.ahead], ['behind', nb.behind]] as const) {
      if (!n) continue;
      let c = this.callouts.get(n.id);
      if (!c) this.callouts.set(n.id, (c = new ConvoyCallouts()));
      const label = gapLabel(dir, n.gapM, n.gapS, rel[n.id]?.lights ?? null);
      const said = c.update(label, now);
      if (said && moving && !muted && name(n.id)) this.sayConvoy(tIn(vl, dir === 'ahead' ? 'cv.say.ahead' : 'cv.say.behind', { name: name(n.id), gap: gapText(said, vl) }), [name(n.id)]);
    }
    // Regroup: every phone runs the same watches; only the leader and the car ahead of the gap are told.
    const prefs = useConvoyPrefs.getState();
    const lim = { m: prefs.regroupM, s: prefs.regroupMin * 60 };
    for (const r of rows) {
      let w = this.regroupWatch.get(r.id);
      if (!w) this.regroupWatch.set(r.id, (w = new RegroupWatch()));
      if (!w.update(r.arrived ? null : r.gapM, r.gapS, lim, now)) continue;
      if (muted || !regroupAudience(rows, leader, r.id).includes(me) || !name(r.id)) continue;
      const gl = gapLabel('behind', r.gapM ?? 0, r.gapS, null);
      const gap = gl ? gapText(gl, vl) : '';
      useDriveAlong.setState({ convoyAlert: { id: r.id, text: t('cv.fellBehind', { name: name(r.id), gap: gl ? gapText(gl, lang()) : '' }), at: now } });
      if (moving) this.sayConvoy(tIn(vl, 'cv.say.regroup', { name: name(r.id), gap }), [name(r.id)], 'alert');
    }
    this.flushSay();
  }

  async decline(from: string): Promise<void> {
    const inv = useDriveAlong.getState().invites.find((i) => i.from === from);
    useDriveAlong.setState((s) => ({ invites: s.invites.filter((i) => i.from !== from) }));
    if (inv)
      await this.crews.companionSend(
        from,
        'drive-along',
        () => ({ v: 1, op: 'decline', sid: inv.op.sid, t: Date.now() }) satisfies DriveAlongOp,
      );
  }

  ignore(from: string): void {
    useDriveAlong.setState((s) => ({ invites: s.invites.filter((i) => i.from !== from) }));
  }

  /** Organiser: stop for everyone. Participant: leave. */
  async stopDriveAlong(): Promise<void> {
    const s = useDriveAlong.getState().session;
    return this.finish(s?.owner === this.me.deviceId ? 'stop' : 'leave');
  }

  /** Leave without ending it for the others; a leaving host hands over (see `successor`). */
  async leaveDriveAlong(): Promise<void> {
    return this.finish('leave');
  }

  private async finish(kind: 'stop' | 'leave'): Promise<void> {
    const s = useDriveAlong.getState().session;
    if (!s) return;
    const op: DriveAlongOp = { v: 1, op: kind, sid: s.sid, t: Date.now() };
    this.setSession(null);
    await Promise.all(
      Object.keys(s.members)
        .filter((id) => id !== this.me.deviceId)
        .map((id) => this.crews.companionSend(id, 'drive-along', () => op)),
    );
  }

  setShareRoute(on: boolean): void {
    const s = useDriveAlong.getState().session;
    if (!s) return;
    this.setSession({ ...s, shareRoute: on });
    this.lastRouteAt = 0;
    this.lastRouteId = null;
    if (!on) void this.sendRoute(true);
    else void this.sendRoute(false);
  }

  private setSession(s: DriveAlongSession | null): void {
    const prev = useDriveAlong.getState().session;
    if (!s) {
      this.cues.clear();
      this.clearConvoy();
      useCompanionLive.setState({ live: {} });
      // Group drive: keep who arrived for the summary card.
      const summary = prev ? groupSummary(prev) : null;
      useDriveAlong.setState({ session: null, routes: {}, regroup: null, followDone: null, ...(summary ? { summary } : {}) });
    } else {
      const wasAll = prev ? allArrived(prev) : false;
      useDriveAlong.setState({ session: s, ...(!wasAll && allArrived(s) ? { summary: groupSummary(s) } : {}) });
    }
    this.setTimer(!!s);
    if (prev && !s) void notify(t('da.ended'), '', { channel: 'circle', silent: true });
  }

  private setTimer(on: boolean): void {
    if (on && !this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const s = useDriveAlong.getState().session;
    if (!s) return this.setTimer(false);
    const r = tick(s, this.me.deviceId, Date.now(), useApp.getState().driving ? null : this.parkedSince);
    if (r.end) {
      // Five minutes after I arrived I stop sending live positions, but the others keep driving.
      void (r.end === 'arrived' ? this.leaveDriveAlong() : this.stopDriveAlong());
      return;
    }
    if (r.session !== s) useDriveAlong.setState({ session: r.session });
    // Parked and waiting for the group: no new fix arrives, so keep the live stream (and my position) going.
    void this.onFix();
    this.updateRegroup();
  }

  private onOp(from: string, raw: unknown): void {
    const op = parseOp(raw);
    if (!op) return;
    const now = Date.now();
    const s = useDriveAlong.getState().session;
    if (op.op === 'invite') {
      if (s?.sid === op.sid) {
        const merged = applyOp(s, from, op, now);
        if (merged) this.onConvoyChange(s, merged);
        useDriveAlong.setState({ session: merged });
        return;
      }
      if (useDriveAlong.getState().invites.some((i) => i.from === from && i.op.sid === op.sid)) return;
      useDriveAlong.setState((st) => ({
        invites: [...st.invites.filter((i) => i.from !== from), { from, op, at: now }],
      }));
      const crewName = op.crew ? useApp.getState().crews.find((c) => c.id === op.crew)?.name : null;
      const title = op.dest
        ? t('gd.invite', { name: op.ownerName, dest: op.dest.name })
        : crewName
          ? t('da.inviteCrew', { name: op.ownerName, crew: crewName })
          : t('da.invite', { name: op.ownerName });
      if (!isMuted(from))
        void notify(title, '', { channel: 'circle', data: { type: 'driveAlong', friendId: from } });
      return;
    }
    if (!s) {
      // Organiser withdrew an invite I had not answered yet.
      if (op.op === 'stop')
        useDriveAlong.setState((st) => ({
          invites: st.invites.filter((i) => !(i.from === from && i.op.sid === op.sid)),
        }));
      return;
    }
    const next = applyOp(s, from, op, now);
    if (!next) return this.setSession(null);
    if (op.op === 'accept' && s.members[from]?.state !== 'joined') {
      this.lastLiveAt = 0;
      this.lastRouteAt = 0;
      this.lastRouteId = null;
    }
    if (op.op === 'leave' || op.op === 'decline') {
      useCompanionLive.setState((l) => {
        const { [from]: _gone, ...live } = l.live;
        return { live };
      });
    }
    this.onConvoyChange(s, next);
    const me = this.me.deviceId;
    if (convoyLeader(next) === me && convoyLeader(s) !== me && !this.convoyMuted(next) && (useApp.getState().nav?.active || useApp.getState().driving))
      this.sayConvoy(tIn(voiceLang(), 'cv.say.youLead'), []);
    this.setSession(next);
    const who = s.members[from]?.name ?? '';
    if (op.op === 'dest' && next.pendingDest && next.pendingDest !== s.pendingDest && !isMuted(from))
      void notify(t('gd.destChanged', { name: who, dest: next.pendingDest.dest.name }), '', {
        channel: 'circle',
        data: { type: 'driveAlong', friendId: from },
      });
    if (op.op === 'arrive' && next !== s && who && !isMuted(from))
      void notify(t('gd.arrivedAt', { name: who, dest: next.dest?.name ?? '' }), '', {
        channel: 'circle',
        silent: true,
        data: { type: 'driveAlong', friendId: from },
      });
  }

  private onLive(m: Incoming, raw: unknown): void {
    const s = useDriveAlong.getState().session;
    if (!s || !s.members[m.sender] || !raw || typeof raw !== 'object') return;
    const p = raw as Presence & { sid?: string };
    if (p.sid !== s.sid || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || typeof p.t !== 'number')
      return;
    const prev = useCompanionLive.getState().live[m.sender];
    if (prev && prev.t > p.t) return;
    const fix = useApp.getState().fix;
    const rel = fix ? relation(fix, p, this.myRoute()) : null;
    useCompanionLive.setState((l) => ({
      live: {
        ...l.live,
        [m.sender]: {
          lat: p.lat,
          lng: p.lng,
          spd: p.spd ?? null,
          hdg: p.hdg ?? null,
          eta: typeof p.eta === 'number' ? p.eta : null,
          t: p.t,
          receivedAt: m.receivedAt,
          rel,
        },
      },
    }));
    this.tracker.update(m.sender, { lat: p.lat, lng: p.lng, t: p.t, spd: p.spd ?? null });
    const next = heard(s, m.sender, Date.now());
    useDriveAlong.setState({ session: next });
  }

  private onRoute(from: string, raw: unknown): void {
    const s = useDriveAlong.getState().session;
    const r = parseRouteShare(raw);
    if (!s || !r || r.sid !== s.sid || !s.members[from]) return;
    useDriveAlong.setState((st) => {
      const routes = { ...st.routes };
      if (r.line.length < 2) delete routes[from];
      else routes[from] = { line: r.line.map(([lat, lng]) => ({ lat, lng })), dest: r.dest, eta: r.eta };
      return { routes };
    });
    this.updateRegroup();
    if (from === convoyLeader(s)) this.updateConvoy();
  }

  private myRoute() {
    const nav = useApp.getState().nav;
    return nav?.active ? routeRef(nav.route.geometry) : null;
  }

  /** Per fix (store subscription): live presence to companions at 1.5 s while driving, relations and voice cues. */
  private async onFix(): Promise<void> {
    const s = useDriveAlong.getState().session;
    const st = useApp.getState();
    const fix = st.fix;
    if (!s || !fix) return;
    const now = Date.now();
    if (s.dest && s.arrived[this.me.deviceId] === undefined && atDestination(fix, s.dest)) {
      // Group drive: tell everyone I got there (distance to the destination, not "navigation ended").
      this.setSession(markArrived(s, this.me.deviceId, now));
      const op: DriveAlongOp = { v: 1, op: 'arrive', sid: s.sid, t: now, rev: s.destRev };
      void Promise.all(liveTargets(s, this.me.deviceId).map((id) => this.crews.companionSend(id, 'drive-along', () => op)));
      return void this.onFix();
    }
    const targets = liveTargets(s, this.me.deviceId);
    if (targets.length && now - this.lastLiveAt >= livePeriodMs(st.driving)) {
      this.lastLiveAt = now;
      const p: Presence = {
        lat: fix.lat,
        lng: fix.lng,
        acc: Math.round(fix.accuracy),
        spd: fix.speed,
        hdg: fix.heading,
        act: st.driving ? 'automotive' : st.activity,
        bat: null,
        chg: false,
        t: fix.t,
        prec: 'p',
      };
      if (st.nav?.active && st.nav.progress) p.eta = st.nav.progress.eta;
      await Promise.all(
        targets.map((id) =>
          this.crews.companionSend(id, 'presence-live', (pol) => {
            const live = livePresenceFor(p, pol, useApp.getState().settings.ghost);
            return live ? { ...live, sid: s.sid } : null;
          }),
        ),
      );
    }
    if (now - this.lastRelAt >= RELATION_EVERY_MS) {
      this.lastRelAt = now;
      this.updateRelations(fix);
      this.updateConvoy();
    }
    // Convoy: the leader always shares the route (followers adopt it and gaps are measured along it).
    if ((s.shareRoute && s.owner === this.me.deviceId) || convoyLeader(s) === this.me.deviceId) void this.sendRoute(false);
    void this.shareEtaTick();
  }

  private updateRelations(fix: LatLng): void {
    const live = useCompanionLive.getState().live;
    if (Object.keys(live).length === 0) return;
    const route = this.myRoute();
    const now = Date.now();
    const out: Record<string, LiveCompanion> = {};
    const names = useDriveAlong.getState().session?.members ?? {};
    const vl = voiceLang();
    const sess = useDriveAlong.getState().session;
    const convoyOn = !!sess && !!convoyLeader(sess);
    for (const [id, c] of Object.entries(live)) {
      const rel = relation(fix, c, route);
      out[id] = { ...c, rel };
      if (!useApp.getState().nav?.active && !useApp.getState().driving) continue;
      let cue = this.cues.get(id);
      if (!cue) this.cues.set(id, (cue = new CompanionCues()));
      const said = cue.update(rel, now);
      const name = names[id]?.name ?? '';
      if (!said || !name) continue;
      // In a convoy the gaps are called by the convoy callouts (along the leader's route).
      if (said.kind === 'gap' && convoyOn) continue;
      if (said.kind === 'gap')
        say(
          tIn(vl, `da.say.${said.label.kind === 'here' ? 'away' : said.label.kind}`, {
            name,
            dist: formatDistance(said.label.m, vl),
          }),
          'guidance',
          [name],
        );
      else
        say(
          tIn(vl, said.kind === 'offRoute' ? 'da.say.offRoute' : 'da.say.backOnRoute', { name }),
          'guidance',
          [name],
        );
    }
    useCompanionLive.setState({ live: out });
  }

  /** Share (or withdraw) my route line with joined companions: on route change, else once a minute. */
  private async sendRoute(withdraw: boolean): Promise<void> {
    const s = useDriveAlong.getState().session;
    const nav = useApp.getState().nav;
    if (!s) return;
    const now = Date.now();
    const routeId = nav?.active ? nav.route.id : null;
    if (!withdraw && (!routeId || (routeId === this.lastRouteId && now - this.lastRouteAt < ROUTE_EVERY_MS)))
      return;
    this.lastRouteAt = now;
    this.lastRouteId = routeId;
    const line =
      withdraw || !nav ? [] : thinRoute(nav.route.geometry).map((p) => [p.lat, p.lng] as [number, number]);
    const value = {
      v: 1,
      sid: s.sid,
      line,
      dest: nav?.destination.name ?? '',
      eta: nav?.progress?.eta ?? null,
      t: now,
    };
    await Promise.all(
      liveTargets(s, this.me.deviceId).map((id) => this.crews.companionSend(id, 'route-share', () => value)),
    );
  }

  /** Regroup suggestion: a shared place (or one of mine) ahead on my route that is also on a companion's route. */
  private updateRegroup(): void {
    const st = useApp.getState();
    const mine = this.myRoute();
    const routes = useDriveAlong.getState().routes;
    let best: { name: string; lat: number; lng: number } | null = null;
    if (mine && st.fix) {
      for (const r of Object.values(routes)) {
        const theirs = routeRef(r.line);
        if (!theirs) continue;
        const p = regroupPoint(st.fix, mine, theirs, st.places);
        if (p) {
          best = { name: p.name, lat: p.lat, lng: p.lng };
          break;
        }
      }
    }
    const cur = useDriveAlong.getState().regroup;
    if (cur?.name !== best?.name) useDriveAlong.setState({ regroup: best });
  }

  // --- ask for location ------------------------------------------------------------------------------------------

  async askLocation(friendId: string): Promise<boolean> {
    if (this.availability(friendId, 'locate', 'loc-request') !== 'ok') return false;
    return this.crews.companionSend(friendId, 'loc-request', () => ({ v: 1, t: Date.now() }));
  }

  private async onLocateRequest(from: string): Promise<void> {
    // Answer = one normal presence update, so every crew policy, ghost mode and per-friend override still apply.
    if (useApp.getState().settings.ghost || !this.locate.allow(from, Date.now())) return;
    await this.publishNow().catch(() => undefined);
    const name = useApp.getState().allFriends[from]?.profile.name ?? '';
    if (name && !isMuted(from))
      void notify(t('fa.locateAsked', { name }), '', {
        channel: 'circle',
        silent: true,
        data: { type: 'friendAlert', friendId: from },
      });
  }

  // --- live ETA share --------------------------------------------------------------------------------------------

  /** Share my live ETA with a friend while navigating; it auto-updates until I arrive or stop. */
  async shareEta(friendId: string, on: boolean): Promise<boolean> {
    const cur = useDriveAlong.getState().etaOut;
    if (!on) {
      useDriveAlong.setState({ etaOut: cur.filter((x) => x !== friendId) });
      this.etaSent.delete(friendId);
      await this.sendEta(friendId, 'cancelled');
      return true;
    }
    if (this.availability(friendId, 'etaShare', 'eta-share') !== 'ok' || !useApp.getState().nav?.active)
      return false;
    if (cur.length === 0) this.etaSid = `eta-${Date.now().toString(36)}`;
    if (!cur.includes(friendId)) useDriveAlong.setState({ etaOut: [...cur, friendId] });
    this.etaSent.delete(friendId);
    await this.shareEtaTick();
    return true;
  }

  private async shareEtaTick(): Promise<void> {
    const pr = useApp.getState().nav?.progress;
    if (!pr) return;
    const now = Date.now();
    for (const id of useDriveAlong.getState().etaOut) {
      if (!etaShareDue(this.etaSent.get(id) ?? null, pr.eta, now)) continue;
      this.etaSent.set(id, { eta: pr.eta, at: now });
      await this.sendEta(id);
    }
  }

  private async sendEta(friendId: string, end?: EtaShare['end']): Promise<void> {
    const nav = useApp.getState().nav;
    const value: EtaShare = {
      v: 1,
      sid: this.etaSid,
      dest: nav?.destination.name ?? '',
      eta: nav?.progress?.eta ?? Date.now(),
      remainingM: nav?.progress?.remainingM ?? 0,
      t: Date.now(),
      ...(end ? { end } : {}),
    };
    await this.crews.companionSend(friendId, 'eta-share', () => value);
  }

  private async endEtaShares(end: EtaShare['end']): Promise<void> {
    const ids = useDriveAlong.getState().etaOut;
    if (ids.length === 0) return;
    useDriveAlong.setState({ etaOut: [] });
    this.etaSent.clear();
    await Promise.all(ids.map((id) => this.sendEta(id, end)));
  }

  private onEta(from: string, raw: unknown): void {
    const e = parseEtaShare(raw);
    if (!e) return;
    const prev = useDriveAlong.getState().etaIn[from];
    if (prev && prev.sid === e.sid && prev.t >= e.t) return;
    const name = useApp.getState().allFriends[from]?.profile.name ?? '';
    useDriveAlong.setState((st) => {
      const etaIn = { ...st.etaIn };
      if (e.end) delete etaIn[from];
      else etaIn[from] = e;
      return { etaIn };
    });
    if (!name || isMuted(from)) return;
    const fc = friendContextNow();
    const arrMode = notifyMode('arrival', fc.ctx, fc.next);
    if (arrMode === 'skip') return;
    if (e.end === 'arrived')
      void notify(t('fa.etaArrived', { name, dest: e.dest }), '', {
        channel: 'circle',
        silent: arrMode === 'silent',
        data: { type: 'friendAlert', friendId: from },
      });
    else if (!e.end && (!prev || prev.sid !== e.sid))
      void notify(t('fa.etaShared', { name, time: formatClock(e.eta), dest: e.dest }), '', {
        channel: 'circle',
        silent: arrMode === 'silent',
        data: { type: 'friendAlert', friendId: from },
      });
  }

  // --- receiver-side alerts --------------------------------------------------------------------------------------

  private checkBatteries(): void {
    for (const [id, f] of Object.entries(useApp.getState().allFriends)) {
      const p = f.presence;
      if (!p) continue;
      let w = this.battery.get(id);
      if (!w) this.battery.set(id, (w = new BatteryWatch()));
      if (w.update(p.bat, p.chg) && !isMuted(id))
        void notify(t('fa.batteryLow', { name: f.profile.name, pct: p.bat ?? 0 }), '', {
          channel: 'circle',
          silent: true,
          data: { type: 'friendAlert', friendId: id },
        });
    }
  }

  /** One-shot arrival subscriptions are removed by the subscriber after they fire. */
  private onArrivalOnce(m: Incoming): void {
    try {
      const a = JSON.parse(fromUtf8(m.payload)) as {
        placeId?: string;
        kind: 'arrive' | 'leave' | 'drivingHome';
      };
      for (const sub of [...this.crews.doc.subscriptions.values()]) {
        if (sub.subscriber !== this.me.deviceId || sub.target !== m.sender || !sub.once) continue;
        if (a.kind !== 'drivingHome' && sub.placeId !== a.placeId) continue;
        const next = consumeOnce(sub, a.kind);
        if (next === sub) continue;
        if (next) this.crews.doc.subscriptions.set(sub.id, next);
        else this.crews.doc.subscriptions.delete(sub.id);
      }
    } catch {
      /* malformed payload: ignore */
    }
  }
}
