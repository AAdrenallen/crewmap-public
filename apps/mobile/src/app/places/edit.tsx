import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, CircleLayer, MapView, ShapeSource } from '@rnmapbox/maps';
import { normalizePlace, PLACE_DEFAULT_RADIUS_M, PLACE_MAX_RADIUS_M, PLACE_MIN_RADIUS_M, PLACE_NAME_MAX, PLACE_TYPE_COLOR, PLACE_TYPES, validPlaceName, type PlaceType } from '@crewmap/shared/places';
import { lang, t } from '@crewmap/shared/i18n';
import { engine } from '../../core/engine';
import { onMapboxLoadingError } from '../../core/errorLog';
import { finite } from '../../core/errorScrub';
import { searchForward, type SearchResult } from '../../core/mapbox';
import { useApp } from '../../core/store';
import { Bouncy, Button, Chip, Field, KeyboardScroll } from '../../ui/kit';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { PLACE_COLORS, PLACE_TYPE_ICON } from '../../ui/places';
import { PlaceShareChips } from '../../ui/PlaceShareChips';
import { useTheme } from '../../ui/theme';
import { ScreenHeader, SectionLabel } from '../../ui/screens-common/Layout';
import { Icon, IconTile } from '../../ui/screens-common/Icon';

/** F7: add/edit a place by search or long-press (lat/lng params); free-text name, type (icon + default colour), per-crew sharing (default: none). */
export default function EditPlace() {
  const params = useLocalSearchParams<{ id?: string; lat?: string; lng?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const me = useApp((s) => s.me);
  const fix = useApp((s) => s.fix);
  const existing = useApp((s) => s.places.find((p) => p.id === params.id));
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<PlaceType>(existing?.type ?? 'home');
  const [color, setColor] = useState<string | null>(existing?.color ?? null);
  const shown = color ?? PLACE_TYPE_COLOR[type];
  const [radius, setRadius] = useState(existing?.radiusM ?? PLACE_DEFAULT_RADIUS_M);
  const [sharedWith, setSharedWith] = useState<string[]>(existing?.sharedWith ?? []);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(
    existing ? { lat: existing.lat, lng: existing.lng } : params.lat && finite(Number(params.lat)) && finite(Number(params.lng)) ? { lat: Number(params.lat), lng: Number(params.lng) } : fix ? { lat: fix.lat, lng: fix.lng } : null,
  );
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) return setResults([]);
    const timer = setTimeout(() => void searchForward(q.trim(), fix, lang()).then(setResults, () => setResults([])), 350);
    return () => clearTimeout(timer);
  }, [q, fix]);

  const save = async () => {
    if (!pos || !me) return;
    setSaving(true);
    try {
      await engine.savePlace(
        normalizePlace({
          id: existing?.id ?? `${me.deviceId.slice(0, 8)}-${Date.now().toString(36)}`,
          owner: me.deviceId,
          name: name.trim(),
          type,
          color: shown,
          lat: pos.lat,
          lng: pos.lng,
          radiusM: radius,
          sharedWith,
          createdAt: existing?.createdAt ?? Date.now(),
        }),
      );
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const [askDelete, setAskDelete] = useState(false);
  const remove = () => setAskDelete(true);

  // Metres → screen pixels at a Mapbox zoom level (512 px tiles), corrected for latitude.
  const mPerPx = (z: number) => (156543.03 * Math.cos(((pos?.lat ?? 0) * Math.PI) / 180)) / 2 ** z / 2;

  return (
    <KeyboardScroll style={{ backgroundColor: th.bg }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <ScreenHeader title={existing ? existing.name : t('places.add')} right={<IconTile name={PLACE_TYPE_ICON[type]} color={shown} size={44} />} />
      <Field testID="place-name" label={t('places.name')} value={name} onChangeText={setName} maxLength={PLACE_NAME_MAX} />
      <Field testID="place-search" label={t('map.search')} value={q} onChangeText={setQ} />
      {results.length > 0 && (
        <View style={[styles.results, { backgroundColor: th.card, borderColor: th.border }]}>
          {results.slice(0, 4).map((r, i) => (
            <Pressable
              key={r.id}
              onPress={() => {
                setPos({ lat: r.lat, lng: r.lng });
                if (!name) setName(r.name.slice(0, PLACE_NAME_MAX));
                setQ('');
              }}
              style={({ pressed }) => [styles.result, { backgroundColor: pressed ? th.cardAlt : 'transparent' }, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: th.border }]}
            >
              <Icon name="pin" color={th.accent} size={20} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: th.text, fontWeight: '700' }} numberOfLines={1}>
                  {r.name}
                </Text>
                <Text style={{ color: th.textSoft, fontSize: 13 }} numberOfLines={1}>
                  {r.address}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
      {pos && (
        <View style={[styles.map, { borderColor: th.border }]}>
          <MapView style={{ flex: 1 }} styleURL="mapbox://styles/mapbox/standard" scaleBarEnabled={false} onMapLoadingError={onMapboxLoadingError} onPress={(f) => setPos({ lat: f.geometry.coordinates[1]!, lng: f.geometry.coordinates[0]! })}>
            <Camera centerCoordinate={[pos.lng, pos.lat]} zoomLevel={radius > 250 ? 14.5 : 15.5} animationDuration={300} />
            <ShapeSource id="place-pos" shape={{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] } }}>
              <CircleLayer
                id="place-radius"
                slot="top"
                style={{ circleRadius: ['interpolate', ['exponential', 2], ['zoom'], 10, radius / mPerPx(10), 20, radius / mPerPx(20)], circleColor: shown, circleOpacity: 0.22, circleStrokeColor: shown, circleStrokeWidth: 2.5, circlePitchAlignment: 'map' }}
              />
              <CircleLayer id="place-center" slot="top" style={{ circleRadius: 7, circleColor: shown, circleStrokeColor: '#FFFFFF', circleStrokeWidth: 3 }} />
            </ShapeSource>
          </MapView>
        </View>
      )}
      <View>
        <SectionLabel>{t('places.type')}</SectionLabel>
        <View style={styles.wrap}>
          {PLACE_TYPES.map((k) => {
            const on = type === k;
            const c = on ? shown : PLACE_TYPE_COLOR[k];
            return (
              <Bouncy key={k} testID={`place-type-${k}`} accessibilityRole="button" accessibilityLabel={t(`placeType.${k}`)} accessibilityState={{ selected: on }} onPress={() => setType(k)} style={[styles.typeBtn, { backgroundColor: on ? c : th.card, borderColor: on ? c : th.border }]}>
                <Icon name={PLACE_TYPE_ICON[k]} color={on ? '#FFFFFF' : c} size={20} />
                <Text style={{ color: on ? '#FFFFFF' : th.text, fontWeight: '600', fontSize: 13.5 }}>{t(`placeType.${k}`)}</Text>
              </Bouncy>
            );
          })}
        </View>
      </View>
      <View>
        <SectionLabel>{t('places.color')}</SectionLabel>
        <View style={styles.wrap}>
          {PLACE_COLORS.map((c) => (
            <Bouncy key={c} accessibilityRole="button" accessibilityLabel={c} accessibilityState={{ selected: shown === c }} onPress={() => setColor(c)} style={[styles.swatch, { borderColor: shown === c ? c : 'transparent' }]}>
              <View style={[styles.swatchInner, { backgroundColor: c }]}>{shown === c && <Icon name="check" color="#FFFFFF" size={20} strokeWidth={3} />}</View>
            </Bouncy>
          ))}
        </View>
      </View>
      <View>
        <SectionLabel>{`${t('places.radius')} · ${radius} m`}</SectionLabel>
        <View style={styles.wrap}>
          {[PLACE_MIN_RADIUS_M, 100, 150, 250, 500, PLACE_MAX_RADIUS_M]
            .filter((r, i, a) => a.indexOf(r) === i)
            .map((r) => (
              <Chip key={r} label={`${r} m`} active={radius === r} onPress={() => setRadius(r)} />
            ))}
        </View>
      </View>
      <View>
        <SectionLabel>{sharedWith.length ? t('places.sharedWith') : t('places.private')}</SectionLabel>
        <PlaceShareChips value={sharedWith} onChange={setSharedWith} />
      </View>
      <Button testID="place-save" label={t('places.save')} disabled={saving || !pos || !validPlaceName(name)} onPress={() => void save()} />
      {existing && <Button kind="danger" label={t('places.delete')} onPress={remove} />}
      {existing && (
        <ConfirmSheet
          visible={askDelete}
          title={t('places.deleteConfirm')}
          message={existing.name}
          confirmLabel={t('places.delete')}
          onCancel={() => setAskDelete(false)}
          onConfirm={() => {
            setAskDelete(false);
            void engine.deletePlace(existing.id);
            router.back();
          }}
        />
      )}
    </KeyboardScroll>
  );
}

const styles = StyleSheet.create({
  results: { borderRadius: 16, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 56 },
  map: { height: 230, borderRadius: 22, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  typeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1.5 },
  swatch: { width: 50, height: 50, borderRadius: 25, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  swatchInner: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
});
