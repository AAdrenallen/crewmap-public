import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

/** Load the repo-root .env (git-ignored). Only public values are embedded in the app. */
function loadEnv(): Record<string, string> {
  const file = resolve(__dirname, '../../.env');
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnv(), ...process.env } as Record<string, string | undefined>;
/** `APP_VARIANT=preview` builds a side-by-side install (own package + name) so testers keep the dev build's data. */
const preview = env.APP_VARIANT === 'preview';

const LOCATION_WHY =
  'CrewMap shares your location with your circle, detects drives and gives turn-by-turn directions, including when the app is in the background.';

const config: ExpoConfig = {
  name: preview ? 'CrewMap Preview' : 'CrewMap',
  slug: 'crewmap',
  scheme: 'crewmap',
  version: '1.0.0',
  orientation: 'default',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  android: {
    package: preview ? 'app.crewmap.preview' : 'app.crewmap',
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
      backgroundColor: '#5B6CFF',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'ACTIVITY_RECOGNITION',
      'POST_NOTIFICATIONS',
      'RECEIVE_BOOT_COMPLETED',
      'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'WAKE_LOCK',
      'RECORD_AUDIO',
      'CAMERA',
      'VIBRATE',
      'ACCESS_NETWORK_STATE',
      'ACCESS_WIFI_STATE',
    ],
    blockedPermissions: ['android.permission.READ_PHONE_STATE'],
    intentFilters: [
      {
        action: 'VIEW',
        data: [{ scheme: 'crewmap', host: 'join' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
      // The shared https invite (site/join). Not autoVerify: a Pages project site cannot host the root
      // /.well-known/assetlinks.json, so the page's intent:// button is the main way in (docs/DECISIONS.md D50).
      {
        action: 'VIEW',
        data: [{ scheme: 'https', host: 'aadrenallen.github.io', pathPrefix: '/crewmap-public/join' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  ios: {
    bundleIdentifier: preview ? 'app.crewmap.preview' : 'app.crewmap',
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHY,
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_WHY,
      NSMotionUsageDescription: 'CrewMap uses motion data to detect when you start and stop driving.',
      NSMicrophoneUsageDescription: 'Record short audio emotes for your friends.',
      NSCameraUsageDescription: 'Scan a friend’s QR code to join their circle.',
      UIBackgroundModes: ['location', 'fetch', 'remote-notification', 'audio'],
      ITSAppUsesNonExemptEncryption: true,
    },
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 160, backgroundColor: '#0E1220' }],
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 26,
          buildArchs: ['arm64-v8a', 'x86_64'],
          // R8: keep JNI-bound WebRTC classes; Dav1d decoder natives are optional in this WebRTC build.
          extraProguardRules: [
            '-keep class org.webrtc.** { *; }',
            '-dontwarn org.webrtc.Dav1dDecoder$Natives',
            '-keep class app.crewmap.platform.** { *; }',
            '-keep class org.unifiedpush.** { *; }',
            // WorkManager's Room DB is created reflectively (no-arg ctor); R8 stripped it -> crash at startup in release.
            '-keep class * extends androidx.room.RoomDatabase { <init>(); }',
            '-keep class androidx.work.impl.** { *; }',
            // expo-gl's JNI looks up GLContext.flush() by name (EXGLJniApi.cpp GetMethodID); R8 inlined it away ->
            // NoSuchMethodError on the first GL context = crash at the first avatar bake (onboarding) in release.
            '-keep class expo.modules.gl.** { *; }',
          ].join('\n'),
        },
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: LOCATION_WHY,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isIosBackgroundLocationEnabled: true,
      },
    ],
    ['expo-notifications', { color: '#5B6CFF' }],
    ['expo-camera', { cameraPermission: 'Scan a friend’s QR code to join their circle.', recordAudioAndroid: false }],
    ['expo-audio', { microphonePermission: 'Record short audio emotes for your friends.' }],
    'expo-sqlite',
    'expo-secure-store',
    'expo-localization',
    'expo-font',
    'expo-asset',
    '@rnmapbox/maps',
    ['@config-plugins/react-native-webrtc', { cameraPermission: false, microphonePermission: false }],
    'react-native-libsodium',
    './plugins/withReleaseSigning',
    './plugins/withGradleMemory',
    './plugins/withCmakeDir',
    './plugins/withExternalNav',
  ],
  experiments: { typedRoutes: false },
  extra: {
    mapboxPublicToken: env.MAPBOX_PUBLIC_TOKEN ?? '',
    // Paid Waze fallback is off unless both a key and a monthly cap > 0 are set (docs/DECISIONS.md D11).
    wazePaidKey: Number(env.WAZE_PAID_MONTHLY_CAP_USD ?? 0) > 0 ? (env.WAZE_PAID_API_KEY ?? '') : '',
    wazePaidCapUsd: Number(env.WAZE_PAID_MONTHLY_CAP_USD ?? 0),
    // Open Charge Map (D64): free key from .env; empty = adapter off.
    ocmKey: env.OCM_API_KEY ?? '',
    router: {},
  },
};

export default config;
