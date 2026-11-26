import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';
import { DEFAULT_ROUTE_OPTIONS, type Congestion, type NavRoute, type RouteCandidate, type RouteOptions } from '@crewmap/shared/navigation';
import { formatClock, formatDistance, formatMinutes } from '@crewmap/shared/units';
import { lang, t } from '@crewmap/shared/i18n';
import { engine } from '../core/engine';
import { useDriveAlong } from '../core/companions';
import { finite } from '../core/errorScrub';
import { loadRouteOptions, setRouteOptions } from '../core/nav';
import { useApp } from '../core/store';
import { useBackClose } from '../ui/useBackClose';
import { CrewMapView } from '../ui/map/CrewMapView';
import { useLayoutMode } from '../ui/layout';
import { Badge, Bouncy, Button, EmptyState, Icon, IconButton, Sheet } from '../ui/kit';
import { font, palette, radius, type, useTheme } from '../ui/theme';
import { ExternalNavButtons } from '../ui/nav/ExternalNavButtons';
import { RouteHazards } from '../ui/nav/RouteHazards';
import { RouteOptionsPanel } from '../ui/nav/RouteOptionsPanel';
import { ShareEta } from '../ui/nav/ShareEta';

const TRAFFIC: Record<Congestion, string | null> = {
  unknown: null,
  low: palette.trafficFree,
  moderate: palette.trafficModerate,
  heavy: palette.trafficHeavy,
  severe: palette.trafficSevere,
};

/** Congestion strip along the route, segments weighted by length. */
function TrafficBar({ r, fallback }: { r: NavRoute; fallback: string }) {
  const n = r.congestion.length;
  if (n === 0 || r.cum.length < 2 || r.distanceM <= 0) return <View style={[styles.bar, { backgroundColor: fallback }]} />;
  const runs: { from: number; to: number; c: string }[] = [];
  for (let i = 0; i < n; i++) {
    const c = TRAFFIC[r.congestion[i]!] ?? fallback;
    const from = (r.cum[i] ?? 0) / r.distanceM;
    const to = (r.cum[i + 1] ?? r.distanceM) / r.distanceM;
    const last = runs[runs.length - 1];
    if (last && last.c === c) last.to = to;
    else runs.push({ from, to, c });
  }
  return (
    <View style={[styles.bar, { overflow: 'hidden' }]}>
      <Svg width="100%" height="100%" viewBox="0 0 1000 6" preserveAspectRatio="none">
        {runs.map((s, i) => (
          <Rect key={i} x={s.from * 1000} y={0} width={Math.max(1, (s.to - s.from) * 1000)} height={6} fill={s.c} />
        ))}
      </Svg>
    </View>
  );
}

/** Route preview with alternatives (traffic-aware ETAs), then Go → turn-by-turn. */
export default function RoutePreview() {
  const { name, lat, lng, with: withIds } = useLocalSearchParams<{ name: string; lat: string; lng: string; with?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lay = useLayoutMode();
  const wide = lay.wide;
  const th = useTheme();
  const nav = useApp((s) => s.nav);
  const session = useDriveAlong((s) => s.session);
  const [routes, setRoutes] = useState<RouteCandidate[] | null>(null);
  const dest = useMemo(() => ({ name: name ?? '', lat: Number(lat), lng: Number(lng) }), [name, lat, lng]);
  const sameDest = !!session?.dest && Math.abs(session.dest.lat - dest.lat) < 1e-4 && Math.abs(session.dest.lng - dest.lng) < 1e-4;
  const selected = nav?.route ?? routes?.[0]?.route ?? null;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [opts, setOpts] = useState<RouteOptions>(DEFAULT_ROUTE_OPTIONS);
  const [optsOpen, setOptsOpen] = useState(false);
  const [optsReady, setOptsReady] = useState(false);

  useEffect(() => {
    void loadRouteOptions().then((o) => {
      setOpts(o);
      setOptsReady(true);
    });
  }, []);

  const changeOpts = (o: RouteOptions) => {
    setOpts(o);
    // Persist, then re-request: preview() reads the stored options.
    void setRouteOptions(o).then(() => setAttempt((n) => n + 1));
  };

  useEffect(() => {
    if (!optsReady) return;
    // Deep link or restored screen without a usable destination: nothing to route to.
    if (!finite(dest.lat) || !finite(dest.lng)) {
      setError(t('err.title'));
      return;
    }
    let live = true;
    setError(null);
    setRoutes(null);
    // The screen can be restored (process restart, reload) before the engine has booted.
    engine
      .boot()
      .then(() => engine.nav.preview(dest))
      .then((r) => live && setRoutes(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      if (!useApp.getState().nav?.active) useApp.getState().set({ nav: null });
    };
  }, [dest, attempt, optsReady]);

  // Incidents on the selected route come from its Mapbox response: republish so their markers show on the preview map.
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) engine.hazards.refresh();
  }, [selectedId]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useBackClose(close);

  return (
    <View style={{ flex: 1 }}>
      <CrewMapView onHazardPress={(h) => router.push({ pathname: '/hazard/[id]', params: { id: h.id } })} />
      {/* Wide screens: the list becomes a left panel (Google Maps style) and the map stays visible on the right. */}
      <View style={[styles.topBar, { top: insets.top + 8, left: wide ? lay.panelW + insets.left + 12 + 8 : Math.max(14, insets.left + 8) }]}>
        <IconButton testID="route-back" icon="back" label={t('common.back')} onPress={close} />
      </View>
      <View style={[styles.topBarRight, { top: insets.top + 8 }]}>
        <IconButton testID="route-options" icon="sliders" label={t('route.options')} active={optsOpen} onPress={() => setOptsOpen((o) => !o)} />
      </View>
      <Sheet style={[styles.sheet, wide ? [styles.panel, { width: lay.panelW + insets.left, paddingLeft: insets.left + 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }] : { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.destRow}>
          <View style={[styles.destIcon, { backgroundColor: `${palette.pop}22` }]}>
            <Icon name="pin" size={22} color={palette.pop} />
          </View>
          <Text style={[type.title, { color: th.text, flex: 1 }]} numberOfLines={1}>
            {name}
          </Text>
        </View>

        {optsOpen && <RouteOptionsPanel value={opts} onChange={changeOpts} />}
        {error ? (
          <EmptyState icon="alert" title={error} action={{ label: t('common.retry'), onPress: () => setAttempt((n) => n + 1) }} />
        ) : routes === null ? (
          <ActivityIndicator style={{ marginVertical: 24 }} color={th.accent} size="large" />
        ) : routes.length === 0 ? (
          <EmptyState icon="route" title={t('nav.noRoute')} action={{ label: t('common.retry'), onPress: () => setAttempt((n) => n + 1) }} />
        ) : (
          <ScrollView style={wide ? styles.panelList : { maxHeight: 240 }} contentContainerStyle={{ gap: 10 }} showsVerticalScrollIndicator={false}>
            {routes.map((c, i) => {
              const r = c.route;
              const label = c.label.kind === 'road' ? t('nav.via', { road: c.label.road }) : t('nav.routeLetter', { letter: c.label.letter });
              const active = selected?.id === r.id;
              // Green = the recommended route; "+N min vs usual" carries the traffic so colour never contradicts the badge.
              const delay = c.overUsualMin ?? 0;
              const etaColor = c.badge === 'recommended' ? palette.trafficFree : th.text;
              const delayColor = delay > 10 ? palette.trafficHeavy : palette.trafficModerate;
              return (
                <Animated.View key={r.id} entering={FadeInDown.delay(i * 60).springify().damping(16)}>
                  <Bouncy
                    testID={`route-alt-${i}`}
                    accessibilityLabel={`${formatMinutes(r.durationS)} ${label}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => engine.nav.choose(r)}
                    style={[styles.alt, { borderColor: active ? th.accent : th.border, backgroundColor: active ? th.accentSoft : th.card }]}
                  >
                    <View style={styles.altTop}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[type.num, { color: etaColor, fontSize: 24, lineHeight: 30 }]}>{formatMinutes(r.durationS)}</Text>
                        <Text style={[type.small, font('medium'), { color: th.textSoft }]} numberOfLines={1}>
                          {t('nav.arrive', { time: formatClock(Date.now() + r.durationS * 1000) })} · {formatDistance(r.distanceM, lang())}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 6 }}>
                        {c.badge === 'recommended' && <Badge tone="ok" label={t('nav.recommended')} />}
                        {c.badge === 'fastestNow' && <Badge tone="accent" label={t('nav.fastestNow')} />}
                        {delay > 0 && <Text style={[type.caption, font('bold'), { color: delayColor }]}>{t('nav.overUsual', { min: delay })}</Text>}
                        {r.incidents.length > 0 && (
                          <View style={styles.inc}>
                            <Icon name="alert" size={14} color={th.warn} />
                            <Text style={[type.caption, font('bold'), { color: th.warn }]}>{r.incidents.length}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <Text style={[type.headline, { color: th.text }]} numberOfLines={1}>
                      {label}
                    </Text>
                    <TrafficBar r={r} fallback={th.accent} />
                  </Bouncy>
                </Animated.View>
              );
            })}
          </ScrollView>
        )}

        {selected && routes !== null && routes.length > 0 && <RouteHazards route={selected} />}
        {selected && routes !== null && routes.length > 0 && <ShareEta route={selected} destName={name} />}
        {selected && <ExternalNavButtons route={selected} destination={dest} others={(routes ?? []).map((c) => c.route).filter((r) => r.id !== selected.id)} />}
        {session?.owner === engine.me.deviceId && Object.keys(session.members).length > 1 && (
          <Text testID="route-invite-status" style={[type.small, font('medium'), { color: th.textSoft }]}>
            {Object.entries(session.members)
              .filter(([id]) => id !== engine.me.deviceId)
              .map(([, m]) => `${m.name} · ${t(`da.${m.state}`)}`)
              .join('   ')}
          </Text>
        )}
        {routes !== null && routes.length > 0 && (!session || session.owner === engine.me.deviceId) && (
          <Button testID="route-drive-along" kind="secondary" icon="users" label={t('gd.invitePeople')} onPress={() => router.push({ pathname: '/drive-along', params: { name: dest.name, lat: String(dest.lat), lng: String(dest.lng), ...(withIds ? { with: withIds } : {}) } })} />
        )}
        {routes !== null && routes.length > 0 && session?.owner === engine.me.deviceId && !sameDest && (
          <Button
            testID="route-group-dest"
            kind="secondary"
            icon="users"
            label={t('gd.useDest')}
            onPress={() => {
              void engine.companions.changeDestination(dest);
              engine.nav.start();
              router.replace('/');
            }}
          />
        )}
        {routes !== null && routes.length > 0 && (
          <Button
            testID="nav-go"
            icon="compass"
            label={t('nav.go')}
            onPress={() => {
              engine.nav.start();
              router.replace('/');
            }}
          />
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { position: 'absolute', left: 14 },
  topBarRight: { position: 'absolute', right: 14 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  panel: { top: 0, right: 'auto', borderTopLeftRadius: 0, borderTopRightRadius: radius.xl, borderBottomRightRadius: radius.xl, gap: 10 },
  panelList: { flex: 1 },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  destIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  alt: { borderWidth: 1.5, borderRadius: radius.l - 4, padding: 14, gap: 8 },
  altTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  inc: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  bar: { height: 6, borderRadius: 3 },
});
