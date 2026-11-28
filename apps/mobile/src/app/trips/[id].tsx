import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, CircleLayer, LineLayer, MapView, ShapeSource, StyleImport } from '@rnmapbox/maps';
import { useMapLightPreset } from '../../ui/map/CrewMapView';
import { bboxOf } from '@crewmap/shared/geo';
import { replayAt, speedSeries, type RiskyEvent, type Trip } from '@crewmap/shared/driving';
import { formatClock, formatKm, formatMinutes, formatSpeed } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import * as db from '../../core/db';
import { onMapboxLoadingError } from '../../core/errorLog';
import { engine } from '../../core/engine';
import { hasMapboxToken, reverseCity } from '../../core/mapbox';
import { Bouncy, Button, Card, Chip } from '../../ui/kit';
import { dateLocale, Glyph, Scrubber, ScoreRing, SpeedChart, speedColor } from '../../ui/charts';
import { useTheme } from '../../ui/theme';
import { EmptyState, SectionLabel, SwitchRow } from '../../ui/screens-common/Layout';
import { ScreenHeader } from '../../ui/kit';
import { Icon, IconTile, type IconName } from '../../ui/kitIcons';

type EvKind = 'hardBrake' | 'rapidAccel' | 'cornering' | 'speeding' | 'phoneHandling' | 'lateNight' | 'crash';
const EVENT_STYLE: Record<EvKind, { icon: IconName; color: string }> = {
  hardBrake: { icon: 'brake', color: '#E5484D' },
  rapidAccel: { icon: 'accel', color: '#FB8C00' },
  cornering: { icon: 'corner', color: '#8E44AD' },
  speeding: { icon: 'speed', color: '#FFB224' },
  phoneHandling: { icon: 'phone', color: '#2EC4B6' },
  lateNight: { icon: 'moon', color: '#3C46C9' },
  crash: { icon: 'crash', color: '#B91C1C' },
};
const evStyle = (k: string) => EVENT_STYLE[k as EvKind] ?? { icon: 'warning' as IconName, color: '#8A93A8' };
const RATES = [1, 4, 16] as const;
const TICK_MS = 100;

/** F1d: interactive route (speed colours, event pins with callout, replay scrubber), speed chart, 0-100 score, passenger override. */
export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const mapPreset = useMapLightPreset();
  const l = lang();
  const cam = useRef<React.ElementRef<typeof Camera>>(null);
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined);
  const [selected, setSelected] = useState<RiskyEvent | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<(typeof RATES)[number]>(4);
  const [chartW, setChartW] = useState(280);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void db.loadTrip(id).then(
      (x) => {
        setTrip(x ?? null);
        if (x) setTime(x.points[0]?.t ?? x.startedAt);
      },
      () => setTrip(null),
    );
  }, [id]);

  // Android hardware back: close the callout first, then leave (home when there is no history).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selected) {
        setSelected(null);
        return true;
      }
      if (!router.canGoBack()) {
        router.replace('/');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selected, router]);

  const first = trip?.points[0]?.t ?? 0;
  const last = trip?.points[trip.points.length - 1]?.t ?? 0;
  const series = useMemo(() => (trip ? speedSeries(trip.points) : []), [trip]);

  // Replay clock.
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => {
      setTime((p) => {
        const n = p + TICK_MS * rate;
        if (n >= last) {
          setPlaying(false);
          return last;
        }
        return n;
      });
    }, TICK_MS);
    return () => clearInterval(h);
  }, [playing, rate, last]);

  const state = useMemo(() => (trip ? replayAt(trip.points, series, time) : null), [trip, series, time]);

  const segments = useMemo(() => {
    if (!trip || trip.points.length < 2) return null;
    const features: { type: 'Feature'; properties: { color: string }; geometry: { type: 'LineString'; coordinates: [number, number][] } }[] = [];
    let curColor = '';
    let coords: [number, number][] = [];
    for (let i = 1; i < trip.points.length; i++) {
      const prev = trip.points[i - 1]!;
      const p = trip.points[i]!;
      const color = speedColor(p.speed * 3.6, p.limitKph);
      if (color === curColor && coords.length > 0) {
        coords.push([p.lng, p.lat]);
      } else {
        curColor = color;
        coords = [
          [prev.lng, prev.lat],
          [p.lng, p.lat],
        ];
        features.push({
          type: 'Feature',
          properties: { color },
          geometry: { type: 'LineString', coordinates: coords },
        });
      }
    }
    return { type: 'FeatureCollection' as const, features };
  }, [trip]);
  const pins = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: (trip?.events ?? []).map((e) => ({
        type: 'Feature' as const,
        id: e.id,
        properties: { id: e.id, color: evStyle(e.kind).color, sel: selected?.id === e.id ? 1 : 0 },
        geometry: { type: 'Point' as const, coordinates: [e.lng, e.lat] },
      })),
    }),
    [trip, selected],
  );
  const marker = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: state ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [state.lng, state.lat] } }] : [],
    }),
    [state],
  );
  const bounds = useMemo(() => {
    if (!trip || trip.points.length === 0) return undefined;
    const b = bboxOf(trip.points, 300);
    return { ne: [b.east, b.north] as [number, number], sw: [b.west, b.south] as [number, number], paddingTop: 40, paddingBottom: 40, paddingLeft: 30, paddingRight: 30 };
  }, [trip]);

  const pick = useCallback((e: RiskyEvent) => {
    setPlaying(false);
    setSelected(e);
    cam.current?.setCamera({ centerCoordinate: [e.lng, e.lat], zoomLevel: 16, animationDuration: 800, animationMode: 'flyTo' });
  }, []);

  const scrubToDistance = useCallback(
    (d: number) => {
      if (series.length === 0) return;
      let lo = 0;
      let hi = series.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (series[mid]!.d < d) lo = mid + 1;
        else hi = mid;
      }
      setPlaying(false);
      setTime(series[lo]!.t);
    },
    [series],
  );

  const driveAgain = async () => {
    if (!trip || busy) return;
    const end = trip.points[trip.points.length - 1]!;
    setBusy(true);
    const city = hasMapboxToken() ? await reverseCity(end).catch(() => null) : null;
    setBusy(false);
    router.push({ pathname: '/route', params: { name: city ?? t('trip.end'), lat: String(end.lat), lng: String(end.lng) } });
  };
  const showOnMap = () => {
    if (!trip) return;
    const p = state ?? trip.points[0]!;
    router.navigate({ pathname: '/', params: { focusLat: String(p.lat), focusLng: String(p.lng) } });
  };

  if (trip === undefined) return <ActivityIndicator color={th.accent} style={{ flex: 1, backgroundColor: th.bg }} />;
  if (trip === null || !segments || trip.points.length === 0)
    return (
      <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
        <View style={{ paddingHorizontal: 16 }}>
          <ScreenHeader title={t('trips.title')} />
        </View>
        <EmptyState icon="car" title={t('trips.empty')} />
      </View>
    );

  const locale = dateLocale(l);
  const tiles: [IconName, string, string][] = [
    ['road', t('trip.distance'), formatKm(trip.distanceM / 1000, l)],
    ['clock', t('trip.duration'), formatMinutes(trip.durationS)],
    ['speed', t('trip.top'), formatSpeed(trip.topSpeedKph, l)],
    ['chart', t('trip.avg'), formatSpeed(trip.avgSpeedKph, l)],
  ];
  const frac = last > first ? (time - first) / (last - first) : 0;
  const events = [...trip.events].sort((a, b) => a.t - b.t);

  return (
    <View style={{ flex: 1, backgroundColor: th.bg, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: 16 }}>
        <ScreenHeader title={new Date(trip.startedAt).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <View style={{ height: 320 }} testID="trip-map">
          <MapView style={{ flex: 1 }} styleURL="mapbox://styles/mapbox/standard" scaleBarEnabled={false} onMapLoadingError={onMapboxLoadingError} compassEnabled={false} onPress={() => setSelected(null)}>
            <StyleImport id="basemap" existing config={{ lightPreset: mapPreset }} />
            <Camera ref={cam} defaultSettings={bounds ? { bounds } : undefined} />
            <ShapeSource id="trip" shape={segments}>
              <LineLayer id="trip-casing" slot="top" style={{ lineColor: '#FFFFFF', lineWidth: 9, lineCap: 'round', lineJoin: 'round', lineOpacity: 0.9 }} />
              <LineLayer id="trip-line" slot="top" style={{ lineColor: ['get', 'color'], lineWidth: 5.5, lineCap: 'round', lineJoin: 'round' }} />
            </ShapeSource>
            <ShapeSource
              id="trip-events"
              shape={pins}
              hitbox={{ width: 36, height: 36 }}
              onPress={(e) => {
                const fid = e.features[0]?.properties?.id as string | undefined;
                const ev = trip.events.find((x) => x.id === fid);
                if (ev) pick(ev);
              }}
            >
              <CircleLayer id="trip-event-dots" slot="top" style={{ circleRadius: ['case', ['==', ['get', 'sel'], 1], 11, 8], circleColor: ['get', 'color'], circleStrokeColor: '#FFFFFF', circleStrokeWidth: 3 }} />
            </ShapeSource>
            <ShapeSource id="trip-marker" shape={marker}>
              <CircleLayer id="trip-marker-dot" slot="top" style={{ circleRadius: 9, circleColor: th.accent, circleStrokeColor: '#FFFFFF', circleStrokeWidth: 3.5 }} />
            </ShapeSource>
          </MapView>
          {selected && (
            <Card style={styles.callout}>
              <View testID="trip-callout" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconTile name={evStyle(selected.kind).icon} color={evStyle(selected.kind).color} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.evLabel, { color: th.text }]}>{t(`ev.${selected.kind as EvKind}`)}</Text>
                  <Text style={{ color: th.textSoft, fontWeight: '600', fontSize: 13 }}>
                    {formatClock(selected.t)} · {formatSpeed(selected.speedKph, l)}
                    {selected.limitKph ? ` · ${t('trip.limit')} ${formatSpeed(selected.limitKph, l)}` : ''}
                  </Text>
                </View>
              </View>
            </Card>
          )}
        </View>
        <View style={{ padding: 16, gap: 16 }}>
          <Card style={{ gap: 4 }}>
            <View style={styles.replayTop}>
              <Bouncy testID="trip-play" accessibilityRole="button" accessibilityLabel={playing ? t('trip.pause') : t('trip.play')} onPress={() => {
                if (!playing && time >= last) setTime(first);
                setPlaying(!playing);
              }} style={[styles.play, { backgroundColor: th.accent }]}>
                <Glyph kind={playing ? 'pause' : 'play'} color={th.onAccent} />
              </Bouncy>
              <View style={{ flex: 1 }}>
                <Text testID="trip-speed" style={[styles.tileNum, { color: th.text }]}>{formatSpeed(state?.kph ?? 0, l)}</Text>
                <Text style={{ color: th.textSoft, fontWeight: '600', fontSize: 13 }}>
                  {formatClock(time)}
                  {state?.limitKph ? ` · ${t('trip.limit')} ${formatSpeed(state.limitKph, l)}` : ''}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {RATES.map((r) => (
                  <Chip key={r} testID={`trip-rate-${r}`} label={`${r}×`} active={rate === r} onPress={() => setRate(r)} />
                ))}
              </View>
            </View>
            <Scrubber testID="trip-scrubber" label={t('trip.duration')} value={frac} onStart={() => setPlaying(false)} onChange={(f) => setTime(first + f * (last - first))} />
            <Text style={[styles.sub, { color: th.textSoft }]}>{t('trip.speedChart')}</Text>
            <View onLayout={(e) => setChartW(Math.floor(e.nativeEvent.layout.width))}>
              <SpeedChart samples={series} width={chartW} cursorD={state?.d ?? null} onScrub={scrubToDistance} unit={formatSpeed(0, l).replace(/^0 /, '')} />
            </View>
          </Card>
          <Animated.View entering={FadeInDown.duration(300)}>
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
              <ScoreRing score={trip.score} size={116} label={t('trip.score')} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={[styles.date, { color: th.text }]}>
                  {formatClock(trip.startedAt)} – {formatClock(trip.endedAt)}
                </Text>
              </View>
            </Card>
          </Animated.View>
          <View style={styles.grid}>
            {tiles.map(([icon, k, v], i) => (
              <Animated.View key={k} entering={FadeInDown.delay(60 + i * 40).duration(260)} style={styles.tileWrap}>
                <Card style={styles.tile}>
                  <Icon name={icon} color={th.accent} size={20} />
                  <Text style={[styles.tileNum, { color: th.text }]}>{v}</Text>
                  <Text style={{ color: th.textSoft, fontSize: 13, fontWeight: '600' }}>{k}</Text>
                </Card>
              </Animated.View>
            ))}
          </View>
          <View>
            <SectionLabel>{t('trip.events')}</SectionLabel>
            <Card style={{ gap: 4 }}>
              {events.length === 0 ? (
                <View style={styles.event}>
                  <IconTile name="sparkle" color="#30A46C" size={32} />
                  <Text style={[styles.evLabel, { color: th.text }]}>{t('trip.noEvents')}</Text>
                </View>
              ) : (
                events.map((e) => (
                  <Bouncy key={e.id} testID={`trip-event-${e.id}`} accessibilityRole="button" onPress={() => pick(e)} style={styles.event}>
                    <IconTile name={evStyle(e.kind).icon} color={evStyle(e.kind).color} size={32} />
                    <Text style={[styles.evLabel, { color: th.text }]}>{t(`ev.${e.kind as EvKind}`)}</Text>
                    <Text style={[styles.evTime, { color: th.textSoft }]}>{formatClock(e.t)}</Text>
                  </Bouncy>
                ))
              )}
            </Card>
          </View>
          <View style={{ gap: 10 }}>
            <Button testID="trip-show-map" kind="secondary" label={t('trip.showMap')} onPress={showOnMap} />
            <Button testID="trip-again" label={t('trip.again')} onPress={() => void driveAgain()} />
          </View>
          <View style={[styles.group, { backgroundColor: th.card, borderColor: th.border }]}>
            <SwitchRow testID="trip-passenger" icon="users" tint="#6E56CF" label={t('trip.passenger')} value={trip.passenger} onChange={(v) => void engine.tracking.setPassenger(trip, v).then(setTrip)} last />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  callout: { position: 'absolute', left: 12, right: 12, bottom: 12, padding: 12 },
  replayTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  play: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  sub: { fontSize: 13, fontWeight: '700', marginTop: 8 },
  date: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tileWrap: { width: '48.5%' },
  tile: { padding: 14, gap: 6 },
  tileNum: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  event: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  evLabel: { flex: 1, fontSize: 15, fontWeight: '600' },
  evTime: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  group: { borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
});
