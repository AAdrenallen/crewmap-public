import { create } from 'zustand';
import type { FuelGrade, MergedHazard, Poi, SourceHealth } from '@crewmap/hazards';
import type { FriendPresence, QuipMeta, SharingPolicy, TransportConfig, UserOverride } from '@crewmap/p2p';
import type { AvatarConfig, CarConfig } from '@crewmap/shared/avatar';
import type { Activity, RiskyEvent } from '@crewmap/shared/driving';
import type { FasterOffer, NavRoute, ProgressState, RouteCandidate } from '@crewmap/shared/navigation';
import type { Place, ProximityMoment } from '@crewmap/shared/places';
import type { AggSet, Period, SharedStats } from '@crewmap/shared/stats';
import type { EmoteMessage } from '@crewmap/shared/emotes';
import { NO_RIDE_MUTES, type RideMutes } from '@crewmap/shared/rideMutes';
import type { Fix } from '@crewmap/platform';

export interface Profile {
  deviceId: string;
  name: string;
  avatar: AvatarConfig;
  car: CarConfig;
  /** UnifiedPush endpoint for content-free wake pings (shared inside the encrypted doc). */
  wake?: string | null;
  /** Only the fields the owner allowed (F1e), per period. */
  stats?: Partial<Record<Period, SharedStats>>;
  driving?: { drivingIntervalMs?: number };
}

export interface FriendView {
  profile: Profile;
  presence: FriendPresence | null;
  paused: boolean;
  /** Routed ETA (s) and distance (m) from me, from Mapbox Matrix. */
  etaS: number | null;
  routeM: number | null;
  isOwner: boolean;
  /** Crews we share with this friend (a friend in two crews is shown once). */
  crews: string[];
  /** A one-time location share (D47) is what shows for this friend until `until` (ms epoch). */
  once?: { until: number };
}

export interface CrewInfo {
  id: string;
  name: string;
  ownerId: string;
  epoch: number;
  memberIds: string[];
  isAdmin: boolean;
}

export interface IncomingEmote {
  id: string;
  from: string;
  msg: EmoteMessage;
  at: number;
  /** Emotes combined into one celebration (absent = 1). */
  count?: number;
  /** Running combo of live emotes: one growing burst, not a planned multi-burst. */
  live?: boolean;
  /** Local file for custom clips. */
  clipUri?: string;
  /** A custom quip: meta (caption/emoji/creator) and the local image file. */
  quip?: { id: string; meta: QuipMeta; imageUri?: string };
}

export type MapTheme = 'adaptive' | 'light' | 'dark';

export interface Settings {
  ghost: boolean;
  retentionDays: number;
  drivingEmoteSound: boolean;
  drivingEmotePopups: boolean;
  moments: boolean;
  friendsNearM: number;
  lang: 'en' | 'fr' | 'ru';
  pcRelayUrl: string;
  transport: TransportConfig;
  hazardAlerts: boolean;
  /** Spoken output while driving: everything, hazard alerts only, or silent. */
  voice: VoiceMode;
  /** Navigation voice + Mapbox instruction language; null follows the app language. */
  voiceLang: 'en' | 'fr' | 'ru' | null;
  /** Read road/place names with a voice of their own language (mixed speakers); off = one speaker per utterance. */
  namesOwnVoice: boolean;
  /** Read chat messages aloud while driving (only with voice 'on'). */
  readChatAloud: boolean;
  /** Hide message text in system notifications. */
  hideChatPreviews: boolean;
  /** Publish own hazard reports to the anonymous public network (D41; off until the user opts in). */
  anonPublish: boolean;
  /** Receive anonymous public hazard reports for the cells along the route (default on). */
  anonReceive: boolean;
  /** Switch to a faster route automatically instead of offering it (D43). */
  autoSwitchFaster: boolean;
  /** Fuel grade whose price the map pins and fuel search show (D64). */
  fuelGrade: FuelGrade;
  /** Fuel prices, chargers and traffic cameras on the map. */
  mapPois: boolean;
  /** Map lighting: follow local sun (adaptive), always light, or always dark. */
  mapTheme: MapTheme;
  /** Safety check-in (D66): minutes stopped somewhere remote before the phone asks. */
  checkInWaitMin: number;
}

export type VoiceMode = 'on' | 'alerts' | 'off';

export interface NavSession {
  route: NavRoute;
  /** Route preview choices (first = fastest); the selected one is `route`. */
  candidates: RouteCandidate[];
  destination: { name: string; lat: number; lng: number };
  progress: ProgressState | null;
  active: boolean;
  rerouting: boolean;
  /** "Faster route available, saves N min" (D43); the driving UI renders it, Navigator.acceptFaster/dismissFaster act. */
  faster?: FasterOffer | null;
}

export type AppFriendAggs = Record<string, { t: number; a: AggSet }>;

export interface AppState {
  ready: boolean;
  onboarded: boolean;
  me: Profile | null;
  /** The crew in focus: the map filter's crew, else the first one. */
  circle: { id: string; name: string; ownerId: string; epoch: number } | null;
  crews: CrewInfo[];
  /** Map filter: one crew id, or null for all crews. */
  crewFilter: string | null;
  /** What this phone reveals to each crew. */
  sharing: Record<string, SharingPolicy>;
  /** Per-friend overrides of the crew policies (D52), by deviceId. */
  shareOverrides: Record<string, UserOverride>;
  /** Leaderboard aggregates received from friends (D57); a friend who never sent one is absent. */
  friendAggs: AppFriendAggs;
  /** Every friend across crews (merged); friends is this filtered by crewFilter. */
  allFriends: Record<string, FriendView>;
  friends: Record<string, FriendView>;
  fix: Fix | null;
  activity: Activity;
  driving: boolean;
  tripStartedAt: number | null;
  /** Last finished trip summary (for the calm trip-end card); never synced. */
  lastTripEnd: {
    id: string;
    at: number;
    durationS: number;
    events: number;
    passenger: boolean;
    roughSpot?: { lat: number; lng: number } | null;
  } | null;
  liveEvents: RiskyEvent[];
  limitKph: number | null;
  nav: NavSession | null;
  hazards: MergedHazard[];
  hazardHealth: SourceHealth[];
  /** Fuel stations, chargers, traffic cameras around the view / route (D64), merged across sources. */
  pois: Poi[];
  emotes: IncomingEmote[];
  /** Per friend: emotes older than a day, summarised silently (never blasted). */
  emoteDigest: Record<string, { count: number; latestAt: number }>;
  /** 'Mute {name}' / 'Mute all' for emotes, until the ride ends (shared/rideMutes). */
  rideMutes: RideMutes;
  /** Unread chat messages per thread (friend deviceId or `crew:<id>`). */
  chatUnread: Record<string, number>;
  /** Bumped when any thread changes (chat screen reloads). */
  chatRev: number;
  /** Thread on screen right now (no notification, auto-read). */
  chatOpen: string | null;
  moments: ProximityMoment[];
  places: Place[];
  settings: Settings;
  online: boolean;
  set: (p: Partial<AppState>) => void;
  patchSettings: (p: Partial<Settings>) => void;
  patchFriend: (id: string, p: Partial<FriendView>) => void;
}

export const useApp = create<AppState>((set) => ({
  ready: false,
  onboarded: false,
  me: null,
  circle: null,
  crews: [],
  crewFilter: null,
  sharing: {},
  shareOverrides: {},
  friendAggs: {},
  allFriends: {},
  friends: {},
  fix: null,
  activity: 'unknown',
  driving: false,
  tripStartedAt: null,
  lastTripEnd: null,
  liveEvents: [],
  limitKph: null,
  nav: null,
  hazards: [],
  hazardHealth: [],
  pois: [],
  emotes: [],
  emoteDigest: {},
  rideMutes: NO_RIDE_MUTES,
  chatUnread: {},
  chatRev: 0,
  chatOpen: null,
  moments: [],
  places: [],
  settings: {
    ghost: false,
    retentionDays: 30,
    drivingEmoteSound: true,
    drivingEmotePopups: true,
    moments: true,
    friendsNearM: 500,
    lang: 'en',
    pcRelayUrl: '',
    transport: { presence: 'p2p', emotes: 'p2p', arrivals: 'p2p', sync: 'p2p', chores: 'p2p', wake: 'p2p' },
    hazardAlerts: true,
    voice: 'on',
    voiceLang: null,
    namesOwnVoice: false,
    readChatAloud: false,
    hideChatPreviews: false,
    anonPublish: false,
    anonReceive: true,
    autoSwitchFaster: false,
    fuelGrade: 'regular',
    mapPois: true,
    mapTheme: 'adaptive',
    checkInWaitMin: 5,
  },
  online: true,
  set: (p) => set(p),
  patchSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
  patchFriend: (id, p) =>
    set((s) => {
      const f = s.friends[id];
      if (!f) return {};
      return { friends: { ...s.friends, [id]: { ...f, ...p } } };
    }),
}));
