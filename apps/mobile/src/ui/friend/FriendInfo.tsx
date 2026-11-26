import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { lang, t } from '@crewmap/shared/i18n';
import {
  agoParts,
  nearestPlaceWithin,
  presenceKind,
  todayTimeline,
  type FriendEvent,
} from '@crewmap/shared/friend';
import { formatClock, formatKm, formatSpeed, kph } from '@crewmap/shared/units';
import { cityFor, loadFriendLogs, useFriendPrefs } from '../../core/friendPrefs';
import { useApp, type FriendView } from '../../core/store';
import { BatteryIcon, Card, Icon, SectionLabel, type IconName } from '../kit';
import { font, type, useTheme } from '../theme';
import { useNow } from './useNow';
import { awayLabel, useWithFriend } from './friendMetrics';

const NO_EVENTS: FriendEvent[] = [];

function Line({ icon, children, testID }: { icon: IconName; children: string; testID?: string }) {
  const th = useTheme();
  return (
    <View style={styles.line}>
      <Icon name={icon} size={18} color={th.textSoft} />
      <Text testID={testID} style={[type.body, { color: th.text, flex: 1 }]}>
        {children}
      </Text>
    </View>
  );
}

const EVENT_ICON: Record<FriendEvent['kind'], IconName> = {
  arrive: 'pin',
  leave: 'route',
  drivingHome: 'home',
};

function eventLabel(e: FriendEvent): string {
  return e.kind === 'arrive'
    ? t('friend.arrivedAt', { place: e.placeName })
    : e.kind === 'leave'
      ? t('friend.leftPlace', { place: e.placeName })
      : t('friend.startedHome');
}

/** Presence details (state, speed, battery, last update, place) and today's shared timeline for one friend. */
export function FriendInfo({ id, f }: { id: string; f: FriendView }) {
  const th = useTheme();
  const now = useNow();
  const places = useApp((s) => s.places);
  const fix = useApp((s) => s.fix);
  const withFriend = useWithFriend(f);
  const events = useFriendPrefs((s) => s.events[id] ?? NO_EVENTS);
  const p = f.presence;
  const [city, setCity] = useState<string | null>(null);

  useEffect(() => {
    void loadFriendLogs(id).catch(() => undefined);
  }, [id]);

  const place = useMemo(
    () =>
      p
        ? nearestPlaceWithin(
            p,
            places.filter((pl) => pl.visibility === 'shared'),
          )
        : null,
    [p, places],
  );
  const lat = p?.lat;
  const lng = p?.lng;
  useEffect(() => {
    setCity(null);
    if (place || lat === undefined || lng === undefined) return;
    let live = true;
    void cityFor({ lat, lng }).then((c) => {
      if (live) setCity(c);
    });
    return () => {
      live = false;
    };
  }, [place, lat, lng]);

  const timeline = useMemo(() => todayTimeline(events, now), [events, now]);
  const week = f.profile.stats?.week;
  const weekKm =
    week && (week.drivenKm !== undefined || week.walkedKm !== undefined)
      ? (week.drivenKm ?? 0) + (week.walkedKm ?? 0)
      : null;

  if (f.paused || !p) return null;
  const away = awayLabel(f, fix);
  const stale = now - p.t > 5 * 60_000;
  const ago = agoParts(p.t, now);
  const speed = kph(p.spd);
  const where = place
    ? t(stale ? 'friend.lastAt' : 'friend.at', { place: place.name })
    : city
      ? t(stale ? 'friend.lastCity' : 'friend.inCity', { city })
      : null;

  return (
    <>
      <Card style={{ gap: 10 }}>
        <Line icon="motion" testID="friend-kind">
          {[
            t(`friend.kind.${presenceKind(p.act, p.spd)}`),
            speed !== null && speed > 0 ? formatSpeed(speed, lang()) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Line>
        {away && (
          <Line icon="route" testID="friend-away">
            {away}
          </Line>
        )}
        {withFriend && (
          <Line icon="users" testID="friend-with">
            {withFriend}
          </Line>
        )}
        {where && (
          <Line icon="pin" testID="friend-where">
            {where}
          </Line>
        )}
        <Line icon="clock" testID="friend-updated">
          {t(`friend.ago.${ago.unit}`, { n: ago.n })}
        </Line>
        {p.bat !== null && (
          <View style={styles.line}>
            <BatteryIcon pct={p.bat} charging={p.chg} size={16} color={th.textSoft} />
            <Text style={[type.body, { color: th.text }]}>{t('map.battery', { pct: p.bat })}</Text>
          </View>
        )}
      </Card>

      {(timeline.length > 0 || weekKm !== null) && (<>
      <SectionLabel>{t('friend.today')}</SectionLabel>
      <Card style={{ gap: 12 }}>
        {timeline.map((e) => (
          <View key={`${e.t}-${e.placeId}-${e.kind}`} style={styles.line} testID="friend-event">
            <Icon name={EVENT_ICON[e.kind]} size={18} color={th.accent} />
            <Text style={[type.body, { color: th.text, flex: 1 }]} numberOfLines={1}>
              {eventLabel(e)}
            </Text>
            <Text style={[type.caption, font('medium'), { color: th.textSoft }]}>{formatClock(e.t)}</Text>
          </View>
        ))}
        {weekKm !== null && (
          <Text style={[type.caption, font('medium'), { color: th.textSoft }]}>
            {t('friend.weekKm', { km: formatKm(weekKm, lang()) })}
          </Text>
        )}
      </Card>
      </>)}
    </>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 24 },
});
