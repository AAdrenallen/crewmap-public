import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatC10, FUEL_GRADES, POI_TUNING, rankFuel, type FuelSort } from '@crewmap/hazards';
import { lang, t } from '@crewmap/shared/i18n';
import { formatDistance } from '@crewmap/shared/units';
import { engine } from '../core/engine';
import { useApp } from '../core/store';
import { Chip, IconTile, ListItem } from './kit';
import { poiAge } from './nav/age';
import { palette, type, useTheme } from './theme';

const MAX_ROWS = 12;

/** Fuel search (D64): stations around the user from the on-device caches, cheapest or nearest first, per grade. */
export function FuelResults({ onPick }: { onPick: (name: string, lat: number, lng: number) => void }) {
  const th = useTheme();
  const fix = useApp((s) => s.fix);
  const grade = useApp((s) => s.settings.fuelGrade);
  const [sort, setSort] = useState<FuelSort>('price');
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let alive = true;
    const at = useApp.getState().fix;
    void (at && engine.hazards ? engine.hazards.pois.ensureFuel(at, Date.now()) : Promise.resolve()).then(() => alive && setRev((n) => n + 1));
    return () => {
      alive = false;
    };
  }, []);

  const hits = useMemo(() => {
    if (!fix || !engine.hazards) return [];
    const now = Date.now();
    return rankFuel(engine.hazards.pois.near(fix, POI_TUNING.searchRadiusM, now), fix, grade, sort).slice(0, MAX_ROWS);
    // `rev` re-reads the cache after an on-demand fetch.
  }, [fix?.lat, fix?.lng, grade, sort, rev]);

  if (!fix) return null;
  const now = Date.now();
  return (
    <View testID="fuel-results" style={{ paddingBottom: 8 }}>
      <Text style={[type.small, { color: th.textSoft, fontWeight: '700', paddingTop: 8 }]}>{t('fuel.nearby')}</Text>
      <View style={styles.chips}>
        {FUEL_GRADES.map((g) => (
          <Chip key={g} testID={`fuel-grade-${g}`} label={t(`fuel.${g}`)} active={grade === g} onPress={() => void engine.saveSettings({ fuelGrade: g })} />
        ))}
        <Chip testID="fuel-sort-price" label={t('fuel.cheapest')} active={sort === 'price'} onPress={() => setSort('price')} />
        <Chip testID="fuel-sort-distance" label={t('fuel.nearest')} active={sort === 'distance'} onPress={() => setSort('distance')} />
      </View>
      {hits.length === 0 ? <Text style={[type.small, { color: th.textSoft, paddingVertical: 8 }]}>{t('fuel.none')}</Text> : null}
      {hits.map((h) => {
        const name = h.poi.brand ?? h.poi.name ?? t('poi.fuel');
        const old = h.price ? now - h.price.at > POI_TUNING.staleMs : false;
        return (
          <ListItem
            key={h.poi.id}
            testID={`fuel-hit-${h.poi.id}`}
            title={name}
            subtitle={[h.poi.address, h.price ? (old ? t('fuel.old') : poiAge(h.price.at, now)) : t('fuel.noPrice')].filter(Boolean).join(' · ')}
            onPress={() => onPick(name, h.poi.lat, h.poi.lng)}
            leading={<IconTile icon="flame" color={palette.pop} />}
            trailing={
              <View style={{ alignItems: 'flex-end' }}>
                {h.price ? <Text style={[type.body, { color: old ? th.textSoft : th.text, fontWeight: '700' }]}>{t('fuel.price', { price: formatC10(h.price.c10) })}</Text> : null}
                <Text style={[type.small, { color: th.textSoft }]}>{formatDistance(h.distanceM, lang())}</Text>
              </View>
            }
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 6 },
});
