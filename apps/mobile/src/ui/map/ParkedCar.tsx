import { memo, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { LineLayer, MarkerView, ShapeSource, type LineLayerStyle } from '@rnmapbox/maps';
import { useRouter } from 'expo-router';
import { t } from '@crewmap/shared/i18n';
import { loadParking, useParking } from '../../core/parking';
import { useApp } from '../../core/store';
import { useMapBearing } from './mapBearing';
import { ParkedSprite } from './Sprites';

const ANCHOR = { x: 0.5, y: 0.6 };
// Constant style (D28): dotted walking line to the car.
const WALK: LineLayerStyle = { lineColor: '#2EC4B6', lineOpacity: 0.85, lineWidth: 4, lineDasharray: [0.6, 1.6], lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1 };

/** Where did I park (D67): the user's own car, small and still, where it was parked; hidden while driving. */
export const ParkedCar = memo(function ParkedCar() {
  const spot = useParking((s) => s.state.spot);
  const enabled = useParking((s) => s.prefs.enabled);
  const walk = useParking((s) => s.walk);
  const car = useApp((s) => s.me?.car ?? null);
  const driving = useApp((s) => s.driving || s.nav?.active === true);
  useEffect(() => {
    void loadParking().catch(() => undefined);
  }, []);
  if (!spot || !enabled || !car || driving) return null;
  return <ParkedCarVisible spot={spot} walk={walk} car={car} />;
});

const ParkedCarVisible = memo(function ParkedCarVisible({
  spot,
  walk,
  car,
}: {
  spot: NonNullable<ReturnType<typeof useParking.getState>['state']['spot']>;
  walk: ReturnType<typeof useParking.getState>['walk'];
  car: NonNullable<ReturnType<typeof useApp.getState>['me']>['car'];
}) {
  const router = useRouter();
  const bearing = useMapBearing((s) => s.bearing);
  const coord = useMemo(() => [spot.lng, spot.lat], [spot.lng, spot.lat]);
  const walkShape = useMemo(
    () => (walk ? { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: walk.line.map((p) => [p.lng, p.lat]) } } : null),
    [walk],
  );
  return (
    <>
      {walkShape && (
        <ShapeSource id="parked-walk" shape={walkShape}>
          <LineLayer id="parked-walk-line" slot="top" style={WALK} />
        </ShapeSource>
      )}
      <MarkerView coordinate={coord} allowOverlap anchor={ANCHOR}>
        <Pressable testID="parked-car" accessibilityRole="button" accessibilityLabel={t('park.marker')} onPress={() => router.push('/parked')} style={styles.hit} hitSlop={8}>
          <ParkedSprite car={car} heading={spot.heading} bearing={bearing} size={44} />
        </Pressable>
      </MarkerView>
    </>
  );
});

const styles = StyleSheet.create({ hit: { alignItems: 'center', justifyContent: 'center', opacity: 0.95 } });
