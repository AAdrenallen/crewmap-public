import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../../core/engine';
import { matrixFrom } from '../../core/mapbox';
import { useApp } from '../../core/store';
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
  const [etaS, setEtaS] = useState<number | null>(null);
  const hasFix = !!fix;
  useEffect(() => {
    const f = useApp.getState().fix;
    if (!p || !f) return;
    let live = true;
    matrixFrom(f, [p]).then(
      (m) => live && setEtaS(m.durationS[0] ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [p?.id, p?.lat, p?.lng, hasFix]);
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
    </View>
  );
}
