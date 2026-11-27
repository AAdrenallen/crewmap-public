import { requireNativeModule, type EventSubscription } from 'expo';

/** Typed handle on the Kotlin module in android/src/main/java/app/crewmap/platform/CrewmapPlatformModule.kt. */
export interface CrewmapPlatformNative {
  startActivityUpdates(intervalMs: number): Promise<boolean>;
  stopActivityUpdates(): Promise<boolean>;
  getLastActivity(): { activity: string; confidence: number; t: number } | null;
  getScreenState(): { interactive: boolean; locked: boolean };
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): boolean;
  openAppBatterySettings(): boolean;
  deviceInfo(): { manufacturer: string; brand: string; model: string; sdk: number; release: string };
  getPushEndpoint(): string | null;
  getPushDistributors(): string[];
  registerPush(): Promise<boolean>;
  unregisterPush(): void;
  setSharingEnabled(on: boolean): void;
  externalNavAvailable(): string[];
  externalNavLaunch(app: string, url: string): boolean;
  overlayCanDraw(): boolean;
  overlayRequestPermission(): boolean;
  overlayShow(): boolean;
  overlayHide(): void;
  overlayUpdate(json: string): void;
  navStatusHasAccess(): boolean;
  navStatusRequestAccess(): boolean;
  ttsSpeak(segments: { lang: string; text: string }[]): Promise<boolean>;
  ttsIsSpeaking(): boolean;
  ttsVoiceStatus(lang: string): Promise<'ok' | 'missing'>;
  ttsInstallVoice(): boolean;
  ttsVoiceName(lang: string): Promise<string | null>;
  ttsVoices(): Promise<{ name: string; locale: string; quality: number; network: boolean }[]>;
  mediaHasAccess(): boolean;
  mediaInstalled(): { pkg: string; label: string }[];
  mediaPreferred(): string | null;
  mediaSetPreferred(pkg: string | null): void;
  mediaStart(): void;
  mediaStop(): void;
  mediaCurrent(): NativeNowPlaying | null;
  mediaControl(action: string): boolean;
  mediaOpenSplit(pkg: string | null): Promise<string>;
  photoCompress(uri: string, maxEdge: number, maxBytes: number): Promise<{ uri: string; width: number; height: number; bytes: number } | null>;
  photoShare(uri: string, mime: string, title: string): Promise<boolean>;
  addListener(event: 'onMedia', cb: (e: ({ none: true } & Partial<NativeNowPlaying>) | ({ none: false } & NativeNowPlaying)) => void): EventSubscription;
  addListener(event: 'onActivity', cb: (e: { activity: string; confidence: number; t: number }) => void): EventSubscription;
  addListener(event: 'onScreen', cb: (e: { kind: 'screenOn' | 'screenOff' | 'unlocked'; t: number }) => void): EventSubscription;
  addListener(event: 'onPushEndpoint', cb: (e: { endpoint: string | null }) => void): EventSubscription;
  addListener(
    event: 'onExternalNavRaw',
    cb: (e: { app: string; title: string | null; text: string | null; subText: string | null; bigText: string | null; t: number }) => void,
  ): EventSubscription;
  addListener(event: 'onExternalNavEnded', cb: (e: { app: string; t: number }) => void): EventSubscription;
  addListener(event: 'onPushMessage', cb: (e: { t: number }) => void): EventSubscription;
}

export interface NativeNowPlaying {
  pkg: string;
  app: string | null;
  title: string | null;
  artist: string | null;
  art: string | null;
  playing: boolean;
  canPrev: boolean;
  canNext: boolean;
  canNextPlaylist: boolean;
}

export const native = requireNativeModule<CrewmapPlatformNative>('CrewmapPlatform');
