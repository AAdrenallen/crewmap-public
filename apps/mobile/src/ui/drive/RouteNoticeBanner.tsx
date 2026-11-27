import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeOut, ZoomIn } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance, formatMinutes } from '@crewmap/shared/units';
import { roadWeather, type RouteNotice } from '../../core/roadWeather';

const SHOW_MS = 10_000;

function Glyph({ kind }: { kind: RouteNotice['kind'] }) {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={11} fill={kind === 'weather' ? '#3B82F6' : '#64748B'} />
      {kind === 'weather' ? (
        // Snowflake
        <Path d="M12 5v14M6 8.5l12 7M18 8.5l-12 7M10 6.2l2 1.6 2-1.6M10 17.8l2-1.6 2 1.6" stroke="#fff" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ) : (
        // Barrier gate
        <Path d="M6 18V8M5 18h2M7 10.5h11M9.5 10.5l2 3M13.5 10.5l2 3" stroke="#fff" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      )}
    </Svg>
  );
}

const title = (n: RouteNotice): string => {
  if (n.kind === 'border') return n.minutes > 0 ? t('border.wait', { name: n.office, min: n.minutes }) : t('border.none', { name: n.office });
  const type = t(`rw.${n.zone.category}`);
  return n.distanceM > 0 ? t('hz.ahead', { type, dist: formatDistance(n.distanceM, lang()) }) : t('rw.here', { type });
};

/** Road-weather / border notice while navigating (D70): shown once with the spoken warning, credit line underneath. */
export function RouteNoticeBanner() {
  const [n, setN] = useState<RouteNotice | null>(null);
  useEffect(() => {
    const l = (x: RouteNotice) => setN(x);
    roadWeather.listeners.add(l);
    return () => {
      roadWeather.listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!n) return;
    const timer = setTimeout(() => setN(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [n]);
  if (!n) return null;
  const label = title(n);
  return (
    <Animated.View entering={ZoomIn.springify().damping(14)} exiting={FadeOut.duration(150)} style={[styles.card, styles.shadow]} testID="route-notice" accessibilityRole="alert" accessibilityLabel={label}>
      <Glyph kind={n.kind} />
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={styles.title} numberOfLines={2}>
          {label}
        </Text>
        {n.kind === 'weather' && n.zone.endM - n.zone.startM >= 1000 ? <Text style={styles.sub}>{formatDistance(n.zone.endM - n.zone.startM, lang())}</Text> : null}
        {n.kind === 'border' && n.minutes > 0 ? <Text style={styles.sub}>{formatMinutes(n.minutes * 60)}</Text> : null}
        <Text style={styles.credit} numberOfLines={1}>
          {n.credit}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(17,22,36,0.96)', borderRadius: 24, paddingVertical: 14, paddingHorizontal: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', maxWidth: 420 },
  title: { color: '#fff', fontSize: 19, fontWeight: '800' },
  sub: { color: 'rgba(255,255,255,0.8)', fontSize: 14, fontWeight: '600' },
  credit: { color: 'rgba(255,255,255,0.55)', fontSize: 11 },
});
