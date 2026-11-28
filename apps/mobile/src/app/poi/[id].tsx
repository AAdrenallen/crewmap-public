import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatC10, FUEL_GRADES, POI_ATTRIBUTION, POI_TUNING, type FuelGrade, type Poi } from '@crewmap/hazards';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { hasMapboxToken, matrixFrom } from '../../core/mapbox';
import { useApp } from '../../core/store';
import { useBackClose } from '../../ui/useBackClose';
import { Badge, Button, Card, EmptyState, H, Icon, SectionLabel, T, type IconName } from '../../ui/kit';
import { poiAge } from '../../ui/nav/age';
import { font, palette, radius, type, useTheme } from '../../ui/theme';

const ICON: Record<Poi['kind'], IconName> = { fuel: 'flame', charging: 'bolt', trafficCamera: 'camera' };

/** Map point sheet: elaborate fuel prices per grade with $/L, nearby avg comparison & age, routed ETA, and one-tap Directions. */
export default function PoiSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const th = useTheme();
  const live = useApp((s) => s.pois.find((x) => x.id === id));
  const allPois = useApp((s) => s.pois);
  const preferredGrade = useApp((s) => s.settings.fuelGrade);
  const fix = useApp((s) => s.fix);
  const last = useRef<Poi | null>(null);
  if (live) last.current = live;
  const p = live ?? last.current;
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useBackClose(close);

  const [etaS, setEtaS] = useState<number | null>(null);
  const hasFix = !!fix;

  // Ensure fresh fuel prices if opened before a viewport refresh finished.
  useEffect(() => {
    if (!p || p.kind !== 'fuel' || !engine.hazards) return;
    void engine.hazards.pois.ensureFuel(p, Date.now()).then(() => engine.hazards.refresh()).catch(() => undefined);
  }, [p?.id, p?.kind]);

  // Routed drive time from current GPS to this POI.
  useEffect(() => {
    const f = useApp.getState().fix;
    if (!p || !f || !hasMapboxToken()) return;
    let alive = true;
    matrixFrom(f, [p]).then(
      (m) => alive && setEtaS(m.durationS[0] ?? null),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [p?.id, p?.lat, p?.lng, hasFix]);

  const nearbyAvg = useMemo(() => {
    const out: Partial<Record<FuelGrade, number>> = {};
    if (!p || p.kind !== 'fuel') return out;
    const now = Date.now();
    for (const g of FUEL_GRADES) {
      const vals: number[] = [];
      for (const other of allPois) {
        if (other.kind !== 'fuel' || other.id === p.id) continue;
        const pr = other.prices?.[g];
        if (!pr || now - pr.at > POI_TUNING.staleMs) continue;
        if (haversineM(p, other) <= 10_000) vals.push(pr.c10);
      }
      if (vals.length >= 2) out[g] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return out;
  }, [p, allPois]);

  if (!p) {
    return (
      <View style={[styles.root, { backgroundColor: th.bg }]}>
        <EmptyState testID="poi-gone" icon="alert" title={t('poi.gone')} action={{ label: t('common.close'), onPress: close }} />
      </View>
    );
  }
  const now = Date.now();
  const title = p.brand ?? p.name ?? t(`poi.${p.kind}`);
  const subName = p.brand && p.name && p.name.toLowerCase() !== p.brand.toLowerCase() ? p.name : null;
  const credits = [...new Set([p.source, ...(p.alsoFrom ?? [])])].map((s) => POI_ATTRIBUTION[s]);
  const meta = [
    t(`poi.${p.kind}`),
    fix ? formatDistance(haversineM(fix, p), lang()) : null,
    etaS !== null ? formatMinutes(etaS) : null,
    p.maxKw ? t('poi.kw', { kw: String(Math.round(p.maxKw)) }) : null,
    p.sockets ? t('poi.spots', { n: p.sockets }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const navigate = () => router.replace({ pathname: '/route', params: { name: title, lat: String(p.lat), lng: String(p.lng) } });
  const hasAnyPrice = !!(p.prices && Object.keys(p.prices).length > 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: th.bg }} contentContainerStyle={styles.root}>
      <Card style={{ gap: 14 }}>
        <View style={styles.head}>
          <View style={[styles.iconBadge, { backgroundColor: p.kind === 'fuel' ? `${palette.warn}22` : th.accentSoft }]}>
            <Icon name={ICON[p.kind]} size={28} color={p.kind === 'fuel' ? palette.warn : th.accent} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <H>{title}</H>
            {subName ? <T soft numberOfLines={1}>{subName}</T> : null}
            {p.address ? <T numberOfLines={2}>{p.address}</T> : null}
            <T soft>{meta}</T>
          </View>
        </View>

        <Button testID="poi-navigate" icon="compass" label={t('hz.navigate')} onPress={navigate} />
        {p.url ? <Button testID="poi-camera" kind="secondary" icon="camera" label={t('poi.view')} onPress={() => void Linking.openURL(p.url!)} /> : null}

        {p.kind === 'fuel' && (
          <View style={{ gap: 8 }} testID="poi-prices">
            <SectionLabel>{t('fuel.allGrades')}</SectionLabel>
            {hasAnyPrice ? (
              <View style={{ gap: 8 }}>
                {FUEL_GRADES.map((g) => {
                  const pr = p.prices?.[g];
                  const isPref = g === preferredGrade;
                  if (!pr) {
                    const sold = p.grades?.includes(g);
                    if (!sold) return null;
                    return (
                      <View key={g} style={[styles.gradeCard, { backgroundColor: th.cardAlt, borderColor: th.border }]}>
                        <Text style={[type.body, font('semibold'), { color: th.text, flex: 1 }]}>{t(`fuel.${g}`)}</Text>
                        <Text style={[type.small, { color: th.textSoft }]}>{t('fuel.noPrice')}</Text>
                      </View>
                    );
                  }
                  const old = now - pr.at > POI_TUNING.staleMs;
                  const dollars = (pr.c10 / 1000).toFixed(2);
                  const avg = nearbyAvg[g];
                  const diffCents = avg !== undefined ? (pr.c10 - avg) / 10 : null;
                  return (
                    <View
                      key={g}
                      style={[
                        styles.gradeCard,
                        {
                          backgroundColor: isPref ? th.accentSoft : th.cardAlt,
                          borderColor: isPref ? th.accent : th.border,
                        },
                      ]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={[type.body, font('bold'), { color: th.text }]}>{t(`fuel.${g}`)}</Text>
                          {g === 'regular' && !old && diffCents !== null && diffCents <= -1.0 && <Badge tone="ok" label={t('fuel.cheapest')} />}
                        </View>
                        <Text style={[type.caption, { color: th.textSoft }]}>
                          {old ? t('fuel.old') : poiAge(pr.at, now)}
                          {diffCents !== null && Math.abs(diffCents) >= 0.5
                            ? ` · ${diffCents < 0 ? t('fuel.belowAvg', { diff: Math.abs(diffCents).toFixed(1) }) : t('fuel.aboveAvg', { diff: diffCents.toFixed(1) })}`
                            : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 1 }}>
                        <Text testID={`poi-price-${g}`} style={[type.title, font('heavy'), { color: old ? th.textSoft : th.text }]}>
                          {t('fuel.price', { price: formatC10(pr.c10) })}
                        </Text>
                        <Text style={[type.caption, font('semibold'), { color: th.textSoft }]}>{t('fuel.perLitre', { dollars })}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <T soft>{t('fuel.noPrice')}</T>
            )}
          </View>
        )}

        <T soft style={{ fontSize: 12 }} testID="poi-attribution">
          {[...credits, p.credit].filter(Boolean).join(' · ')}
        </T>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, paddingBottom: 32 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  iconBadge: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  gradeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.m,
    borderWidth: 1,
  },
});
