import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { decodeInvite } from '@crewmap/p2p';
import { t } from '@crewmap/shared/i18n';
import { extractInviteLink } from '@crewmap/shared/links';
import { engine } from '../core/engine';
import { inviteErrorMessage, inviteStash } from '../core/inviteErrors';
import { useApp } from '../core/store';
import { Button, Card, H, Icon, ScreenHeader, T } from '../ui/kit';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ui/theme';
import { CheckInOptIn, useCheckInChoice } from '../ui/safety/CheckInOptIn';

/** Links already consumed by a successful join: a stale URL must not re-trigger it. */
const consumed = new Set<string>();

/** Handles invite links, `crewmap://join#…` or the https join page (QR or shared one-time link). The invite never leaves the URL fragment. */
export default function Join() {
  const router = useRouter();
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ link?: string }>();
  const url = Linking.useLinkingURL();
  const rawLink = extractInviteLink(params.link ?? '') ?? extractInviteLink(url ?? '');
  const link = rawLink && !consumed.has(rawLink) ? rawLink : null;
  const [state, setState] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle');
  const [joinedId, setJoinedId] = useState<string | null>(null);
  const joinedCheckIn = useApp((s) => (joinedId ? s.sharing[joinedId]?.checkIn === true : false));
  const [error, setError] = useState('');
  const me = useApp((s) => s.me);
  const circleName = (() => {
    try {
      return link ? decodeInvite(link).n : '';
    } catch {
      return '';
    }
  })();

  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const go = async () => {
    if (!link || !me || busy.current) return;
    busy.current = true;
    setState('joining');
    try {
      const id = await engine.crews.join(link, me.name, { checkIn: useCheckInChoice.getState().on });
      consumed.add(link);
      await inviteStash.clear();
      await engine.finishOnboarding();
      // One last choice before the map: the safety check-in for this crew (D66).
      if (alive.current) {
        setJoinedId(id);
        setState('joined');
      }
    } catch (e) {
      if (alive.current) {
        setError(inviteErrorMessage(e));
        setState('error');
      }
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    if (link && me && state === 'idle') void go();
  }, [link, me]);

  // Hardware back: previous screen, or home when this screen is the whole history.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) return false;
      router.replace(me ? '/' : '/onboarding');
      return true;
    });
    return () => sub.remove();
  }, [router, me]);

  // Not onboarded yet: keep the link; onboarding finishes the join once the profile exists.
  useEffect(() => {
    if (link && !me) {
      void inviteStash.stash(link);
      router.replace('/onboarding');
    }
  }, [link, me, router]);

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 12, paddingBottom: insets.bottom, paddingLeft: Math.max(20, insets.left), paddingRight: Math.max(20, insets.right) }}>
      <ScreenHeader onBack={() => router.replace(me ? '/' : '/onboarding')} />
      <View style={styles.body}>
      <View style={[styles.badge, { backgroundColor: th.accentSoft }]}>
        <Icon name={state === 'error' ? 'alert' : 'crew'} size={40} color={state === 'error' ? th.danger : th.accent} />
      </View>
      <H style={{ textAlign: 'center' }}>{circleName || t('onb.join')}</H>
      {!me && <Button label={t('onb.start')} onPress={() => router.replace('/onboarding')} />}
      {state === 'joining' && (
        <>
          <ActivityIndicator color={th.accent} size="large" />
          <T soft style={{ textAlign: 'center' }}>{t('circle.joining')}</T>
        </>
      )}
      {state === 'joined' && joinedId && (
        <>
          <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
            <CheckInOptIn value={joinedCheckIn} onChange={(on) => void engine.crews.setPolicy(joinedId, { checkIn: on })} />
          </Card>
          <Button testID="join-continue" label={t('onb.next')} onPress={() => router.replace('/')} />
        </>
      )}
      {state === 'error' && (
        <>
          <T style={{ color: th.danger, textAlign: 'center' }}>{error}</T>
          <Button icon="link" label={t('common.retry')} onPress={() => void go()} />
        </>
      )}
      {state === 'idle' && me && !link && <Button kind="secondary" icon="qr" label={t('circle.scan')} onPress={() => router.replace('/scan')} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: 'stretch', justifyContent: 'center', gap: 18, paddingBottom: 48 },
  badge: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
});
