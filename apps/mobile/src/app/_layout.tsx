import 'react-native-get-random-values';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { installErrorCapture, recordError, setErrorRoute } from '../core/errorLog';
import { routeOf } from '../core/errorScrub';
import * as Notifications from 'expo-notifications';
import { Stack, router as rootRouter, useRouter, useSegments } from 'expo-router';
import { t } from '@crewmap/shared/i18n';
import type { EmotePreset } from '@crewmap/shared/emotes';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold, useFonts } from '@expo-google-fonts/inter';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { engine } from '../core/engine';
import { commandFor, navigatePath, readData, type NotifCommand } from '../core/notifRoutes';
import { syncNotificationLocale } from '../core/notify';
import { useApp } from '../core/store';
import { Button, T } from '../ui/kit';
import { radius, space, useTheme } from '../ui/theme';

installErrorCapture();
void SplashScreen.preventAutoHideAsync();

/** Root error boundary (expo-router): friendly recover screen instead of the red screen; the error is logged. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const recorded = useRef(false);
  if (!recorded.current) {
    recorded.current = true;
    recordError('render', error);
  }
  return (
    <View testID="error-boundary" style={styles.errWrap}>
      <Text style={styles.errTitle}>{t('err.title')}</Text>
      <Button testID="error-reload" label={t('err.reload')} onPress={() => void retry()} />
    </View>
  );
}
// Boot at module load so background tasks (headless) find the engine initialising.
void engine.boot();

async function execute(cmd: NotifCommand): Promise<void> {
  switch (cmd.kind) {
    case 'open':
      rootRouter.push(cmd.path as never);
      return;
    case 'reply':
      await engine.chat.send(cmd.chatId, cmd.text);
      await engine.chat.markRead(cmd.chatId);
      return;
    case 'markRead':
      await engine.chat.markRead(cmd.chatId);
      return;
    case 'sendBack':
      await engine.emotes.send(cmd.friendId, { preset: cmd.preset as EmotePreset });
      return;
    case 'navigate': {
      const f = useApp.getState().allFriends[cmd.friendId];
      const p = f?.presence;
      rootRouter.push((p ? navigatePath(cmd.placeName || f.profile.name, p.lat, p.lng) : `/friend/${encodeURIComponent(cmd.friendId)}`) as never);
    }
  }
}

function EngineBanner({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.bannerWrap, { top: insets.top + space(2) }]}>
      <View style={[styles.banner, { backgroundColor: th.card, borderColor: th.danger }]}>
        <View style={{ flex: 1 }}>
          <T numberOfLines={2}>{t('engine.failed')}</T>
        </View>
        <Button compact kind="secondary" label={t('common.retry')} loading={busy} onPress={onRetry} />
      </View>
    </View>
  );
}

export default function RootLayout() {
  const booted = useApp((s) => s.ready);
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  const ready = booted && (fontsLoaded || fontError !== null);
  const onboarded = useApp((s) => s.onboarded);
  const th = useTheme();
  const segments = useSegments();
  const router = useRouter();
  const routeKey = routeOf(segments);
  useEffect(() => setErrorRoute(routeKey), [routeKey]);

  const [engineFailed, setEngineFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const lang = useApp((s) => s.settings.lang);

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    const inOnboarding = segments[0] === 'onboarding' || segments[0] === 'join' || segments[0] === 'scan';
    if (!onboarded && !inOnboarding) router.replace('/onboarding');
    else if (onboarded) {
      void engine.run().catch((e: unknown) => {
        if (__DEV__) console.warn('engine run failed', e);
        setEngineFailed(true);
      });
    }
  }, [ready, onboarded, segments, router]);

  const retry = useCallback(() => {
    setRetrying(true);
    engine
      .restartForBenchmark()
      .then(() => setEngineFailed(false))
      .catch((e: unknown) => {
        if (__DEV__) console.warn('engine retry failed', e);
      })
      .finally(() => setRetrying(false));
  }, []);

  // Notification channel and action-button names follow the app language.
  useEffect(() => {
    void Promise.resolve()
      .then(syncNotificationLocale)
      .catch(() => undefined);
  }, [lang]);

  // Notification taps and action buttons: queued until the store is ready and onboarded.
  const gate = useRef(false);
  const queue = useRef<Notifications.NotificationResponse[]>([]);
  const seen = useRef(new Set<string>());
  const flush = useCallback(() => {
    if (!gate.current) return;
    for (const r of queue.current.splice(0)) {
      const key = `${r.notification.request.identifier}|${r.actionIdentifier}|${r.notification.date}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      const cmd = commandFor(r.actionIdentifier, readData(r.notification.request.content.data), (r as { userText?: string }).userText);
      if (cmd) void execute(cmd).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    gate.current = ready && onboarded;
    flush();
  }, [ready, onboarded, flush]);
  useEffect(() => {
    const push = (r: Notifications.NotificationResponse | null) => {
      if (!r) return;
      queue.current.push(r);
      flush();
    };
    const sub = Notifications.addNotificationResponseReceivedListener(push);
    void Notifications.getLastNotificationResponseAsync().then(push).catch(() => undefined);
    return () => sub.remove();
  }, [flush]);

  if (!ready) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: th.bg }}>
      <SafeAreaProvider>
        <StatusBar style={th.dark ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false, presentation: 'card', contentStyle: { backgroundColor: th.bg }, animation: 'slide_from_right' }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
          <Stack.Screen name="friend/[id]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.55, 0.95], sheetGrabberVisible: true }} />
          <Stack.Screen name="emote/[id]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6], sheetGrabberVisible: true }} />
          <Stack.Screen name="hazard/[id]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.35], sheetGrabberVisible: true }} />
          <Stack.Screen name="place/[id]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.42], sheetGrabberVisible: true }} />
          <Stack.Screen name="search" options={{ animation: 'fade_from_bottom' }} />
          <Stack.Screen name="route" options={{ animation: 'fade' }} />
          <Stack.Screen name="scan" options={{ animation: 'slide_from_bottom' }} />
        </Stack>
        {engineFailed && <EngineBanner onRetry={retry} busy={retrying} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  errWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(4), padding: space(6), backgroundColor: '#0E1220' },
  errTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  bannerWrap: { position: 'absolute', left: space(3), right: space(3) },
  banner: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3), borderRadius: radius.m, borderWidth: 1 },
});
