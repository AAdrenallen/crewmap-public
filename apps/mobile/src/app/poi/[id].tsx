import { useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatC10, FUEL_GRADES, POI_ATTRIBUTION, POI_TUNING, type Poi } from '@crewmap/hazards';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance } from '@crewmap/shared/units';
import { useApp } from '../../core/store';
import { useBackClose } from '../../ui/useBackClose';
import { Button, Card, EmptyState, H, Icon, T, type IconName } from '../../ui/kit';
import { poiAge } from '../../ui/nav/age';
import { useTheme } from '../../ui/theme';

const ICON: Record<Poi['kind'], IconName> = { fuel: 'flame', charging: 'bolt', trafficCamera: 'camera' };

/** Map point sheet: fuel prices per grade with age, charger power, traffic-camera link, source credit, navigate. */
export default function PoiSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const th = useTheme();
  const live = useApp((s) => s.pois.find((x) => x.id === id));
  const fix = useApp((s) => s.fix);
  const last = useRef<Poi | null>(null);
  if (live) last.current = live;
  const p = live ?? last.current;
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useBackClose(close);

  if (!p) {
    return (
      <View style={[styles.root, { backgroundColor: th.bg }]}>
        <EmptyState testID="poi-gone" icon="alert" title={t('poi.gone')} action={{ label: t('common.close'), onPress: close }} />
      </View>
    );
  }
  const now = Date.now();
  const title = p.brand ?? p.name ?? t(`poi.${p.kind}`);
  const credits = [...new Set([p.source, ...(p.alsoFrom ?? [])])].map((s) => POI_ATTRIBUTION[s]);
  const meta = [t(`poi.${p.kind}`), fix ? formatDistance(haversineM(fix, p), lang()) : null, p.maxKw ? t('poi.kw', { kw: String(Math.round(p.maxKw)) }) : null, p.sockets ? t('poi.spots', { n: p.sockets }) : null].filter(Boolean).join(' · ');
  const navigate = () => router.replace({ pathname: '/route', params: { name: title, lat: String(p.lat), lng: String(p.lng) } });

  return (
    <View style={[styles.root, { backgroundColor: th.bg }]}>
      <Card style={{ gap: 12 }}>
        <View style={styles.head}>
          <Icon name={ICON[p.kind]} size={32} color={th.accent} />
          <View style={{ flex: 1, gap: 2 }}>
            <H>{title}</H>
            {p.address ? <T numberOfLines={1}>{p.address}</T> : null}
            <T soft>{meta}</T>
          </View>
        </View>
        {p.prices && Object.keys(p.prices).length ? (
          <View style={{ gap: 4 }} testID="poi-prices">
            {FUEL_GRADES.map((g) => {
              const pr = p.prices?.[g];
              if (!pr) return null;
              const old = now - pr.at > POI_TUNING.staleMs;
              return (
                <View key={g} style={styles.priceRow}>
                  <T style={{ flex: 1, fontWeight: '600' }}>{t(`fuel.${g}`)}</T>
                  <T testID={`poi-price-${g}`} style={{ fontWeight: '700', color: old ? th.textSoft : th.text }}>{t('fuel.price', { price: formatC10(pr.c10) })}</T>
                  <T soft style={{ minWidth: 92, textAlign: 'right' }}>{old ? t('fuel.old') : poiAge(pr.at, now)}</T>
                </View>
              );
            })}
          </View>
        ) : p.kind === 'fuel' ? (
          <T soft>{t('fuel.noPrice')}</T>
        ) : null}
        <T soft testID="poi-attribution">{[...credits, p.credit].filter(Boolean).join(' · ')}</T>
        {p.url ? <Button testID="poi-camera" kind="secondary" icon="camera" label={t('poi.view')} onPress={() => void Linking.openURL(p.url!)} /> : null}
        <Button testID="poi-navigate" kind="secondary" icon="route" label={t('hz.navigate')} onPress={navigate} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
