// Waze / Google Maps handoff + floating overlay + navigation-status listener: package-visibility <queries>
// (Android 11+), SYSTEM_ALERT_WINDOW, and the NotificationListenerService declaration.
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const PACKAGES = ['com.waze', 'com.google.android.apps.maps'];
// Music players for the driving split screen (packages/platform/android/.../MediaBridge.kt KNOWN_PLAYERS).
const PLAYERS = [
  'com.spotify.music',
  'com.google.android.apps.youtube.music',
  'com.apple.android.music',
  'deezer.android.app',
  'com.amazon.mp3',
  'au.com.shiftyjelly.pocketcasts',
  'com.soundcloud.android',
  'com.aspiro.tidal',
  'com.qobuz.music',
  'com.maxmpz.audioplayer',
  'fm.player',
];
const SCHEMES = ['google.navigation'];
const LISTENER = 'app.crewmap.platform.NavStatusListener';

module.exports = function withExternalNav(config) {
  config = AndroidConfig.Permissions.withPermissions(config, ['android.permission.SYSTEM_ALERT_WINDOW']);
  return withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults.manifest;
    // Drop any tools:node="remove" entry left by blockedPermissions.
    m['uses-permission'] = (m['uses-permission'] ?? []).filter(
      (p) => !(p.$['android:name'] === 'android.permission.SYSTEM_ALERT_WINDOW' && p.$['tools:node'] === 'remove'),
    );
    if (!m['uses-permission'].some((p) => p.$['android:name'] === 'android.permission.SYSTEM_ALERT_WINDOW')) {
      m['uses-permission'].push({ $: { 'android:name': 'android.permission.SYSTEM_ALERT_WINDOW' } });
    }
    m.queries = m.queries ?? [{}];
    const q = m.queries[0];
    q.package = q.package ?? [];
    for (const name of [...PACKAGES, ...PLAYERS]) {
      if (!q.package.some((p) => p.$['android:name'] === name)) q.package.push({ $: { 'android:name': name } });
    }
    q.intent = q.intent ?? [];
    for (const scheme of SCHEMES) {
      const has = q.intent.some((i) => (i.data ?? []).some((d) => d.$['android:scheme'] === scheme));
      if (!has) q.intent.push({ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], data: [{ $: { 'android:scheme': scheme } }] });
    }
    // System TextToSpeech engines must be visible to bind on Android 11+ (navigation voice, D-voice).
    const TTS = 'android.intent.action.TTS_SERVICE';
    if (!q.intent.some((i) => (i.action ?? []).some((a) => a.$['android:name'] === TTS))) q.intent.push({ action: [{ $: { 'android:name': TTS } }] });
    // Any other player that exposes a MediaBrowserService.
    const BROWSER = 'android.media.browse.MediaBrowserService';
    if (!q.intent.some((i) => (i.action ?? []).some((a) => a.$['android:name'] === BROWSER))) q.intent.push({ action: [{ $: { 'android:name': BROWSER } }] });
    // Notification Access listener: reads only the Waze / Google Maps navigation notification (D25).
    const app = cfg.modResults.manifest.application[0];
    app.service = app.service ?? [];
    if (!app.service.some((s) => s.$['android:name'] === LISTENER)) {
      app.service.push({
        $: {
          'android:name': LISTENER,
          'android:exported': 'true',
          'android:label': '@string/app_name',
          'android:permission': 'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.notification.NotificationListenerService' } }] }],
      });
    }
    return cfg;
  });
};
