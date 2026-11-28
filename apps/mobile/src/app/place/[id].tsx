import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { WIKI_LICENCE } from '@crewmap/hazards';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatClock, formatDistance, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { matrixFrom } from '../../core/mapbox';
import { useWikiSummary } from '../../core/placeInfo';
import { useApp } from '../../core/store';
import { computeTripInsight, type DoorToDoorInsight } from '../../core/tripInsights';
import { useBackClose } from '../../ui/useBackClose';
import { Button, Card, H, SectionLabel, T } from '../../ui/kit';
import { PlaceShareChips } from '../../ui/PlaceShareChips';
import { PLACE_TYPE_ICON } from '../../ui/places';
import { IconTile } from '../../ui/screens-common/Icon';
import { useTheme } from '../../ui/theme';

/** Tapped place pin: name, type, owner, distance/ETA; Navigate, Edit and per-crew sharing for own places. */
export default function PlaceSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const th = useTheme();
  useBackClose(() => (router.canGoBack() ? router.back() : router.replace('/')));
  const p = useApp((s) => s.places.find((x) => x.id === id));
  const mine = useApp((s) => !!p && p.owner === s.me?.deviceId);
  const owner = useApp((s) => (p ? s.friends[p.owner]?.profile.name : undefined));
  const fix = useApp((s) => s.fix);
  const places = useApp((s) => s.places);
  const [etaS, setEtaS] = useState<number | null>(null);
  const [insight, setInsight] = useState<DoorToDoorInsight | null>(null);
  const wikiInfo = useWikiSummary(p);
  const hasFix = !!fix;
  useEffect(() => {
    const f = useApp.getState().fix;
    if (!p || !f) return;
    let live = true;
    matrixFrom(f, [p]).then(
      (m) => live && setEtaS(m.durationS[0] ?? null),
      () => undefined,
    );
    computeTripInsight(f, p, places).then(
      (res) => live && setInsight(res),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [p?.id, p?.lat, p?.lng, hasFix, places]);
  if (!p) return null;
  const meta = [t(`placeType.${p.type}`), !mine ? owner : null, fix ? formatDistance(haversineM(fix, p), lang()) : null, etaS !== null ? formatMinutes(etaS) : null].filter(Boolean).join(' · ');
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, padding: 16 }}>
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <IconTile name={PLACE_TYPE_ICON[p.type]} color={p.color} size={46} />
          <View style={{ flex: 1, gap: 2 }}>
            <H>{p.name}</H>
            <T soft numberOfLines={1}>{meta}</T>
          </View>
        </View>
        {insight && (
          <View testID="place-insight" style={{ gap: 2 }}>
            <T soft style={{ fontSize: 13 }}>
              {t('insight.typicalDrive', { min: Math.max(1, Math.round(insight.typicalS / 60)), n: insight.trips })}
            </T>
            {insight.advice && (
              <T soft style={{ fontSize: 13 }}>
                {t('insight.leaveBy', { arrive: formatClock(insight.arriveAt), leave: formatClock(insight.advice.leaveAt) })}
              </T>
            )}
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Button testID="place-navigate" label={t('places.navigate')} onPress={() => router.replace({ pathname: '/route', params: { name: p.name, lat: String(p.lat), lng: String(p.lng) } })} />
          </View>
          {mine && (
            <View style={{ flex: 1 }}>
              <Button testID="place-edit" kind="secondary" label={t('places.edit')} onPress={() => router.replace({ pathname: '/places/edit', params: { id: p.id } })} />
            </View>
          )}
        </View>
        {mine && (
          <View style={{ gap: 6 }}>
            <SectionLabel>{t('places.sharedWith')}</SectionLabel>
            <PlaceShareChips value={p.sharedWith} onChange={(sharedWith) => void engine.savePlace({ ...p, sharedWith })} />
          </View>
        )}
      </Card>
      {wikiInfo && (
        <Pressable testID="place-wiki" accessibilityRole="link" accessibilityLabel={`${wikiInfo.title}, ${t('wiki.open')}`} onPress={() => void Linking.openURL(wikiInfo.url)}>
          <Card style={{ gap: 6, marginTop: 12 }}>
            <T style={{ fontWeight: '700' }}>{wikiInfo.title}</T>
            <T soft numberOfLines={4}>{wikiInfo.extract}</T>
            <T soft style={{ fontSize: 11 }}>{`Wikipedia · ${WIKI_LICENCE}`}</T>
          </Card>
        </Pressable>
      )}
    </View>
  );
}
