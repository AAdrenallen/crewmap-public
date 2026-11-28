import type { ExternalNavUpdate } from '@crewmap/shared/navigation/externalNavParse';
/**
 * Platform interfaces. Shared code talks only to these; implementations live in `src/<capability>/android.ts`, and each
 * capability folder has `ios/CONTRACT.md` describing the iOS native API and its limits (docs/IOS-PORT.md).
 */
import type { Activity } from '@crewmap/shared/driving';
import type { DirectLinks, Sodium } from '@crewmap/p2p';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

// --- Location + background service -------------------------------------------------------------------------------

export interface Fix {
  t: number;
  lat: number;
  lng: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  altitude: number | null;
}

/** Adaptive sampling profiles (docs/BATTERY.md). */
export type SamplingProfile = 'navigating' | 'driving' | 'walking' | 'still';

export interface HeadingReading {
  t: number;
  deg: number;
  /** True north (else magnetic). */
  isTrue: boolean;
}

export interface LocationService {
  foregroundPermission(): Promise<PermissionState>;
  requestForeground(): Promise<PermissionState>;
  backgroundPermission(): Promise<PermissionState>;
  requestBackground(): Promise<PermissionState>;
  current(): Promise<Fix | null>;
  /** Starts/updates the background location service (Android: location-type foreground service + notification). */
  startBackground(profile: SamplingProfile, notification: { title: string; body: string }): Promise<void>;
  stopBackground(): Promise<void>;
  isBackgroundRunning(): Promise<boolean>;
  /** OS location request starts/stops in the last `windowMs` (diagnostics: a restart loop flicks the status-bar icon). */
  requestChurn(windowMs?: number): { starts: number; stops: number };
  /** Fixes from the background task and foreground watch, batched. */
  onFixes(cb: (fixes: Fix[]) => void): () => void;
  /**
   * Device compass while subscribed (start only when needed: it keeps the magnetometer on). Degrees clockwise from
   * true north when the OS knows it, else magnetic; unreliable readings are dropped. Returns the unsubscribe.
   */
  watchHeading(cb: (r: HeadingReading) => void): () => void;
}

// --- Motion / activity -------------------------------------------------------------------------------------------

export interface ActivityReading {
  t: number;
  activity: Activity;
  confidence: number;
}

export interface MotionService {
  permission(): Promise<PermissionState>;
  request(): Promise<PermissionState>;
  startActivity(intervalMs: number): Promise<void>;
  stopActivity(): Promise<void>;
  lastActivity(): ActivityReading | null;
  onActivity(cb: (a: ActivityReading) => void): () => void;
  /** Linear acceleration magnitude (gravity removed), m/s², at `hz`. */
  startImu(hz: number, cb: (t: number, magnitude: number) => void): () => void;
}

// --- Geofencing --------------------------------------------------------------------------------------------------

export interface GeofenceRegion {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export interface GeofenceService {
  set(regions: GeofenceRegion[]): Promise<void>;
  clear(): Promise<void>;
  onEvent(cb: (e: { id: string; kind: 'enter' | 'exit'; t: number }) => void): () => void;
}

// --- Secure key storage ------------------------------------------------------------------------------------------

export interface SecureKeyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// --- Background networking / wake-ups -----------------------------------------------------------------------------

export interface WakeChannel {
  /** Ask the push distributor for an endpoint; resolves false when no distributor is installed. */
  register(): Promise<boolean>;
  unregister(): void;
  endpoint(): string | null;
  distributors(): string[];
  onEndpoint(cb: (endpoint: string | null) => void): () => void;
  onPing(cb: () => void): () => void;
  /** Persisted flag so sharing restarts after reboot. */
  setSharingEnabled(on: boolean): void;
  /** Register the headless sync handler (runs after a push when the app isn't running, and periodically). */
  registerHeadlessSync(handler: (reason: string) => Promise<void>): void;
}

export type SpeechLang = 'en' | 'fr' | 'ru';

// --- Audio ducking + speech ---------------------------------------------------------------------------------------

export interface AudioService {
  /** Speak a navigation/alert instruction; other app audio is ducked while speaking. */
  speak(text: string, lang: SpeechLang): Promise<void>;
  /**
   * Speak same-language segments back-to-back (queued, no gaps, never cutting each other off), each with its own
   * voice; other app audio is ducked for the whole sequence. Resolves when the last segment ends.
   */
  speakSegments(segments: readonly { text: string; lang: SpeechLang }[]): Promise<void>;
  /** Whether an offline system voice exists for `lang` ('missing' → offer installVoice). */
  voiceStatus(lang: SpeechLang): Promise<'ok' | 'missing'>;
  /** Open the system TTS voice-data install screen. */
  installVoice(): Promise<boolean>;
  /** Name of the specific system voice used for `lang` (Canadian locale preferred), or null. */
  voiceName(lang: SpeechLang): Promise<string | null>;
  /** Installed en/fr/ru voices (dev diagnostics). */
  voices(): Promise<{ name: string; locale: string; quality: number; network: boolean }[]>;
  isSpeaking(): boolean;
  /** Play a short clip (emote). When `duckUnderVoice`, it plays quietly and never interrupts speech. */
  /** `rate` (0.5-2) changes speed and pitch together (no pitch correction), for escalating layers. */
  playClip(uri: string, opts: { duckUnderVoice: boolean; volume?: number; rate?: number }): Promise<void>;
  /** Record up to `maxMs`; resolves with a file URI. */
  /** Records up to maxMs; `onStart` fires the moment the microphone is really recording (the UI countdown starts there). */
  record(maxMs: number, onStart?: () => void): Promise<{ uri: string; durationMs: number; bytes: number }>;
  stopRecording(): Promise<void>;
  micPermission(): Promise<PermissionState>;
  requestMic(): Promise<PermissionState>;
}

// --- Haptics --------------------------------------------------------------------------------------------------------

export type HapticKind = 'tap' | 'select' | 'success' | 'warning' | 'bounce';

export interface HapticsService {
  play(kind: HapticKind): void;
}

// --- Power / OEM guidance -------------------------------------------------------------------------------------------

export interface DeviceInfo {
  manufacturer: string;
  brand: string;
  model: string;
  sdk: number;
  release: string;
}

export interface PowerService {
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): boolean;
  openOemBatterySettings(): boolean;
  device(): DeviceInfo;
  battery(): Promise<{ level: number; charging: boolean }>;
  onBattery(cb: (b: { level: number; charging: boolean }) => void): () => void;
  network(): Promise<{ online: boolean; wifi: boolean }>;
}

// --- Screen state (phone-handling signal) ------------------------------------------------------------------------------

export interface ScreenService {
  current(): { interactive: boolean; locked: boolean };
  onChange(cb: (e: { kind: 'screenOn' | 'screenOff' | 'unlocked'; t: number }) => void): () => void;
  setKeepAwake(on: boolean): void;
}

// --- Deferred: health data + Bluetooth LE (contracts only) -------------------------------------------------------------

export interface HealthSession {
  kind: 'walk' | 'run' | 'cycle' | 'drive';
  start: number;
  end: number;
  distanceM: number;
  steps?: number;
  source: string;
}

/** Deferred (Section F5): Health Connect / HealthKit import. Merge plan in docs/DECISIONS.md D15. */
export interface HealthDataService {
  available(): Promise<boolean>;
  requestRead(): Promise<PermissionState>;
  sessions(since: number, until: number): Promise<HealthSession[]>;
}

/** Deferred (Section 2A): Bluetooth LE transport for nearby peers without internet. */
export interface BleTransport {
  available(): Promise<boolean>;
  advertise(serviceTag: Uint8Array): Promise<void>;
  scan(onPeer: (peerTag: Uint8Array, rssi: number) => void): Promise<() => void>;
  send(peerTag: Uint8Array, bytes: Uint8Array): Promise<boolean>;
  onMessage(cb: (peerTag: Uint8Array, bytes: Uint8Array) => void): () => void;
}

// --- Notification permission ----------------------------------------------------------------------------------------------

export interface NotificationPermission {
  permission(): Promise<PermissionState>;
  request(): Promise<PermissionState>;
}

// --- External navigation handoff (Waze / Google Maps) --------------------------------------------------------------

export type ExternalNavApp = 'waze' | 'gmaps';

export interface ExternalNavService {
  /** Installed navigation apps we can hand a destination to. */
  available(): Promise<ExternalNavApp[]>;
  /** Opens the app in turn-by-turn mode; `via` shapes the route where the app supports waypoints (Google only). */
  launch(app: ExternalNavApp, dest: { lat: number; lng: number }, via?: { lat: number; lng: number }[]): Promise<boolean>;
}

// --- Floating overlay over other apps ----------------------------------------------------------------------------

export interface NavOverlaySnapshot {
  friends: { name: string; color: string; etaMin: number | null }[];
  lastEmote?: { from: string; label: string };
  speedKmh: number;
  score: number | null;
  /** Bubble initials and colour (the user's avatar). */
  me: { initials: string; color: string };
  /** Read from the Waze / Google Maps navigation notification (externalNavStatus). */
  nav?: { remainingMin: number | null; arrival: string | null; nextInstruction: string | null };
}

export interface NavOverlayService {
  /** "Display over other apps" granted. */
  canDraw(): boolean;
  /** Opens the system permission screen; the result shows up in `canDraw()` when the app resumes. */
  requestPermission(): boolean;
  show(): boolean;
  hide(): void;
  update(snapshot: NavOverlaySnapshot): void;
}

// --- Waze / Google Maps navigation status (Notification Access) -------------------------------------------------

export interface ExternalNavStatusService {
  /** Notification Access granted to CrewMap. */
  hasAccess(): boolean;
  /** Opens the system Notification Access screen; the result shows up in `hasAccess()` when the app resumes. */
  requestAccess(): boolean;
  /** Parsed updates from the ongoing navigation notification of Waze / Google Maps only. */
  onUpdate(cb: (u: ExternalNavUpdate) => void): () => void;
  /** The navigation notification went away (guidance ended or the app closed). */
  onEnded(cb: (e: { app: ExternalNavApp; t: number }) => void): () => void;
}

// --- Now playing + music app split screen ---------------------------------------------------------------------

export interface MediaApp {
  pkg: string;
  label: string;
}

/** The active media session of another app. Stays on this device: never logged, stored or sent (privacy rule). */
export interface NowPlaying {
  pkg: string;
  app: string | null;
  title: string | null;
  artist: string | null;
  /** Local file:// (app cache) or https cover URI. */
  art: string | null;
  playing: boolean;
  canPrev: boolean;
  canNext: boolean;
  /** The app exposes a playlist/radio/mix custom action. */
  canNextPlaylist: boolean;
}

export type MediaAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'nextPlaylist';

/** 'split' = opened beside CrewMap; 'app' = opened full screen (overlay bubble shown if permitted); 'none' = nothing to open. */
export type MediaOpenResult = 'split' | 'app' | 'none';

export interface MediaBrowseItem {
  id: string;
  title: string;
  subtitle: string | null;
  art: string | null;
  kind: 'queue' | 'media' | 'folder' | 'search';
  browsable: boolean;
}

export interface MediaService {
  /** Reading sessions needs Notification Access (the same grant as externalNavStatus). */
  hasAccess(): boolean;
  /** Installed music / podcast players. */
  installed(): MediaApp[];
  /** User's pick; null = follow the most recently active session. */
  preferred(): string | null;
  setPreferred(pkg: string | null): void;
  current(): NowPlaying | null;
  /** Fires on every track / play-state change; read `current()` for the initial state. */
  onChange(cb: (np: NowPlaying | null) => void): () => void;
  /** False when the session is gone or the action isn't exposed: open the app instead. */
  control(action: MediaAction): boolean;
  /** Browse playlists / folders (MediaBrowserService) and active queue items for `pkg`. */
  browse(pkg?: string | null, parentId?: string | null): Promise<MediaBrowseItem[]>;
  /** Play a browsed item (`queue` id, `media` id, or `search` playlist query) or open the player (`open`). */
  playItem(pkg: string | null, kind: 'queue' | 'media' | 'search' | 'open', id: string): boolean;
  /** Opens `pkg` (default: preferred → active session → first installed) beside CrewMap in multi-window. */
  openSplit(pkg?: string): Promise<MediaOpenResult>;
}

// --- Trip memory photos (D68) --------------------------------------------------------------------------------------

export interface CompressedPhoto {
  /** file:// JPEG in the app cache. */
  uri: string;
  width: number;
  height: number;
  bytes: number;
}

export interface PhotoService {
  /** Re-encodes an image (file:// or content://) to a JPEG with its longest edge ≤ maxEdge and ≤ maxBytes; EXIF rotation applied, metadata dropped. Null = unreadable. */
  compress(uri: string, maxEdge: number, maxBytes: number): Promise<CompressedPhoto | null>;
  /** Saves a local image to the gallery (Pictures/CrewMap) and opens the share sheet for it. */
  share(uri: string, mime: 'image/png' | 'image/jpeg', title: string): Promise<boolean>;
}

export interface Platform {
  os: 'android' | 'ios';
  location: LocationService;
  motion: MotionService;
  geofence: GeofenceService;
  keys: SecureKeyStore;
  wake: WakeChannel;
  audio: AudioService;
  haptics: HapticsService;
  power: PowerService;
  screen: ScreenService;
  notifications: NotificationPermission;
  externalNav: ExternalNavService;
  navOverlay: NavOverlayService;
  externalNavStatus: ExternalNavStatusService;
  media: MediaService;
  photos: PhotoService;
  /** libsodium implementation (JSI). */
  sodium: Sodium;
  /** WebRTC data-channel links for the router. */
  createDirectLinks(selfDeviceId: string): DirectLinks;
}

export type { ExternalNavUpdate } from '@crewmap/shared/navigation/externalNavParse';
