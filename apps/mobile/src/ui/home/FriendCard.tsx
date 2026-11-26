import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { minutesLeft } from '@crewmap/shared/companions';
import { formatAge } from '@crewmap/shared/units';
import { t } from '@crewmap/shared/i18n';
import { driveLabel, useWithFriend } from '../friend/friendMetrics';
import { useApp, type FriendView } from '../../core/store';
import { AvatarStill } from '../map/Sprites';
import { BatteryIcon, Bouncy, CountBadge, PresenceDot, presenceState } from '../kit';
import { elevation, font, palette, radius, type, useTheme } from '../theme';

/** Carousel card (also the collapsed-sheet card). */
export function FriendCard({
  f,
  onPress,
  onLongPress,
  fill,
}: {
  f: FriendView;
  onPress: () => void;
  onLongPress?: () => void;
  /** Take the width of the container (vertical deck) instead of the fixed carousel width. */
  fill?: boolean;
}) {
  const th = useTheme();
  const unread = useApp((s) => s.chatUnread[f.profile.deviceId] ?? 0);
  const p = f.presence;
  const eta = driveLabel(f, useApp.getState().fix);
  const withFriend = useWithFriend(f);
  return (
    <Bouncy
      onPress={onPress}
      onLongPress={onLongPress}
      testID={`friend-card-${f.profile.name}`}
      accessibilityLabel={f.profile.name}
      style={[styles.card, fill && { width: undefined }, { backgroundColor: th.glass, borderColor: th.separator }, elevation.mid]}
    >
      <View>
        <View style={[styles.avatarRing, { backgroundColor: th.cardAlt }]}>
          <AvatarStill avatar={f.profile.avatar} size={48} />
        </View>
        <View style={styles.dot}>
          <PresenceDot state={presenceState(f)} ring={th.card} size={14} />
        </View>
        {unread > 0 && (
          <CountBadge
            testID={`friend-unread-${f.profile.name}`}
            n={unread}
            style={{ position: 'absolute', top: -4, right: -4 }}
          />
        )}
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[type.headline, { color: th.text }]} numberOfLines={1}>
          {f.profile.name}
        </Text>
        {f.paused ? (
          <Text style={[type.small, { color: th.textSoft }]}>{t('map.paused')}</Text>
        ) : p ? (
          <>
            <Text
              style={[type.small, font('bold'), { color: th.accent }]}
              numberOfLines={1}
              testID={`friend-eta-${f.profile.name}`}
            >
              {eta ?? t(`act.${p.act}`)}
            </Text>
            <View style={styles.meta}>
              {p.bat !== null && <BatteryIcon pct={p.bat} charging={p.chg} size={11} color={th.textSoft} />}
              <Text style={[type.caption, { color: th.textSoft }]} numberOfLines={1}>
                {p.bat !== null ? `${t('map.battery', { pct: p.bat })} · ` : ''}
                {formatAge(p.t, Date.now())}
                {withFriend ? ` · ${withFriend}` : ''}
              </Text>
            </View>
            {!!f.once && (
              <Text style={[type.caption, font('bold'), { color: palette.sun }]} numberOfLines={1} testID={`friend-once-${f.profile.name}`}>
                {t('ask.sharedOnce', { min: minutesLeft(f.once.until, Date.now()) })}
              </Text>
            )}
          </>
        ) : (
          <Text style={[type.small, { color: th.textSoft }]} numberOfLines={1} testID={`friend-not-shared-${f.profile.name}`}>
            {t('ask.notShared')}
          </Text>
        )}
      </View>
    </Bouncy>
  );
}

/** Subscribes to one friend only, so a position update re-renders this card and nothing else. */
export const LiveCard = memo(function LiveCard({
  id,
  onOpen,
  onActions,
  fill,
}: {
  id: string;
  onOpen: (f: FriendView) => void;
  onActions: (f: FriendView) => void;
  fill?: boolean;
}) {
  const f = useApp((s) => s.friends[id]);
  if (!f) return null;
  return <FriendCard f={f} onPress={() => onOpen(f)} onLongPress={() => onActions(f)} fill={fill} />;
});

/** Dense list row: avatar, name, activity, distance / ETA, battery when shared. */
export const LiveRow = memo(function LiveRow({
  id,
  onOpen,
  onActions,
}: {
  id: string;
  onOpen: (f: FriendView) => void;
  onActions: (f: FriendView) => void;
}) {
  const th = useTheme();
  const f = useApp((s) => s.friends[id]);
  const unread = useApp((s) => s.chatUnread[id] ?? 0);
  const withFriend = useWithFriend(f);
  if (!f) return null;
  const p = f.presence;
  const me = useApp.getState().fix;
  const eta = driveLabel(f, me);
  return (
    <Bouncy
      onPress={() => onOpen(f)}
      onLongPress={() => onActions(f)}
      testID={`friend-card-${f.profile.name}`}
      accessibilityLabel={f.profile.name}
      scaleTo={0.985}
      style={styles.row}
    >
      <View>
        <View style={[styles.ringS, { backgroundColor: th.cardAlt }]}>
          <AvatarStill avatar={f.profile.avatar} size={40} />
        </View>
        <View style={styles.dot}>
          <PresenceDot state={presenceState(f)} ring={th.card} size={12} />
        </View>
        {unread > 0 && (
          <CountBadge
            testID={`friend-unread-${f.profile.name}`}
            n={unread}
            style={{ position: 'absolute', top: -4, right: -4 }}
          />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[type.headline, { color: th.text }]} numberOfLines={1}>
          {f.profile.name}
        </Text>
        <Text style={[type.small, { color: th.textSoft }]} numberOfLines={1}>
          {f.paused
            ? t('map.paused')
            : p
              ? [t(`act.${p.act}`), formatAge(p.t, Date.now()), withFriend, f.once ? t('ask.sharedOnce', { min: minutesLeft(f.once.until, Date.now()) }) : ''].filter(Boolean).join(' · ')
              : t('ask.notShared')}
        </Text>
      </View>
      <View style={styles.right}>
        {eta && (
          <Text
            style={[type.small, font('bold'), { color: th.accent }]}
            numberOfLines={1}
            testID={`friend-eta-${f.profile.name}`}
          >
            {eta}
          </Text>
        )}
        {p && p.bat !== null && !f.paused && (
          <View style={styles.meta}>
            <BatteryIcon pct={p.bat} charging={p.chg} size={11} color={th.textSoft} />
            <Text style={[type.caption, { color: th.textSoft }]}>{t('map.battery', { pct: p.bat })}</Text>
          </View>
        )}
      </View>
    </Bouncy>
  );
});

const styles = StyleSheet.create({
  card: {
    width: 260,
    borderRadius: radius.l,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  avatarRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ringS: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  dot: { position: 'absolute', right: 0, bottom: 0 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 60,
  },
  right: { alignItems: 'flex-end', gap: 2, maxWidth: 140 },
});
