import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { agoParts } from '@crewmap/shared/friend';
import { t } from '@crewmap/shared/i18n';
import { peerSupports } from '@crewmap/p2p';
import { engine } from '../../core/engine';
import { useDriveAlong } from '../../core/companions';
import { clearLocate } from '../../core/locate';
import { useApp } from '../../core/store';
import { DRIVE_UX } from '../drive/driveUx';
import { useNow } from '../friend/useNow';
import { Bouncy, Icon, IconButton, type IconName } from '../kit';
import { elevation, font, radius, type, useTheme } from '../theme';
import { LOCATE_UX, locateActions, locateTarget, type LocateAction } from './locateLogic';

const ICON: Record<LocateAction, IconName> = { directions: 'route', along: 'users', ask: 'locate', askOnce: 'clock', chat: 'send', emote: 'chat' };

/**
 * After "Locate": a compact pill with the actions for that crewmate (directions, drive together, ask, message, emote).
 * Hides itself after `LOCATE_UX.autoHideMs` without a touch unless pinned; larger targets while driving.
 */
export function LocatePill({ id, driving, style }: { id: string; driving: boolean; style: object }) {
  const th = useTheme();
  const router = useRouter();
  const now = useNow(15_000);
  const f = useApp((s) => s.allFriends[id]);
  const inDriveAlong = useDriveAlong((s) => s.session?.members[id]?.state === 'joined' || s.session?.members[id]?.state === 'invited');
  const [pinned, setPinned] = useState(false);
  const [touch, setTouch] = useState(0);
  useEffect(() => {
    if (pinned) return;
    const timer = setTimeout(clearLocate, LOCATE_UX.autoHideMs);
    return () => clearTimeout(timer);
  }, [pinned, touch, id]);
  if (!f) return null;
  const target = locateTarget(f, now);
  const actions = locateActions(target, { chat: peerSupports(f.presence, 'chat') !== false, driving });
  const ago = target.kind === 'stale' ? agoParts(target.t, now) : null;
  const size = driving ? DRIVE_UX.targetDp : 48;
  const askLabel = (kind: 'where' | 'once', ok: string) => (engine.asks.availability(id, kind) === 'old' ? t('ask.needsUpdate') : ok);
  const label: Record<LocateAction, string> = {
    directions: t('friend.directions'),
    along: t('gd.title'),
    ask: askLabel('where', t('fa.askLocation')),
    askOnce: askLabel('once', t('locate.askOnce')),
    chat: t('friend.message'),
    emote: t('friend.emote'),
  };
  const run = (a: LocateAction) => {
    clearLocate();
    if (a === 'directions' && target.kind !== 'hidden')
      router.push({ pathname: '/route', params: { name: f.profile.name, lat: String(target.lat), lng: String(target.lng) } });
    else if (a === 'along') router.push(inDriveAlong ? '/drive-along' : { pathname: '/search', params: { with: id } });
    else if (a === 'ask') void engine.asks.ask(id, 'where');
    else if (a === 'askOnce') void engine.asks.ask(id, 'once');
    else if (a === 'chat') router.push({ pathname: '/chat/[id]', params: { id } });
    else router.push({ pathname: '/emote/[id]', params: { id } });
  };
  return (
    <View testID="locate-pill" onTouchStart={() => setTouch((n) => n + 1)} style={[styles.pill, { backgroundColor: th.card, borderColor: th.separator }, elevation.high, style]}>
      <View style={styles.head}>
        <Text style={[type.headline, { color: th.text, flexShrink: 1 }]} numberOfLines={1}>
          {f.profile.name}
        </Text>
        {ago && (
          <Text testID="locate-ago" style={[type.small, font('medium'), { color: th.textSoft }]}>
            {t(`friend.ago.${ago.unit}`, { n: ago.n })}
          </Text>
        )}
        <View style={{ flex: 1 }} />
        <IconButton testID="locate-pin" icon="pin" tone={pinned ? 'accent' : 'plain'} label={t(pinned ? 'locate.unpin' : 'locate.pin')} size={40} onPress={() => setPinned((v) => !v)} />
        <IconButton testID="locate-close" icon="close" tone="plain" label={t('common.close')} size={40} onPress={clearLocate} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
        {actions.map((a) => (
          <Bouncy key={a} testID={`locate-${a}`} accessibilityLabel={label[a]} onPress={() => run(a)} style={[styles.item, { minWidth: size + 16 }]}>
            <View style={[styles.icon, { width: size, height: size, borderRadius: size / 2, backgroundColor: th.accentSoft }]}>
              <Icon name={ICON[a]} size={driving ? 28 : 22} color={th.accent} />
            </View>
            {!driving && (
              <Text style={[type.caption, { color: th.text }]} numberOfLines={1}>
                {label[a]}
              </Text>
            )}
          </Bouncy>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { position: 'absolute', borderRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 6, paddingHorizontal: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8 },
  row: { gap: 4, paddingVertical: 4 },
  item: { alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  icon: { alignItems: 'center', justifyContent: 'center' },
});
