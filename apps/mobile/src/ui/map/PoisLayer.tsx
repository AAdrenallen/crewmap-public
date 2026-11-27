import { memo, useCallback, useMemo, type ComponentProps } from 'react';
import { CircleLayer, ShapeSource, SymbolLayer, type CircleLayerStyle, type SymbolLayerStyle } from '@rnmapbox/maps';
import { useRouter } from 'expo-router';
import { formatC10, POI_TUNING } from '@crewmap/hazards';
import { useApp } from '../../core/store';

const COLOR = { fuel: '#FB8C00', charging: '#30A46C', trafficCamera: '#5B6CFF' } as const;

const S = {
  dot: { circleColor: ['get', 'color'], circleRadius: ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 8], circleStrokeColor: '#FFFFFF', circleStrokeWidth: 2, circleOpacity: ['get', 'op'] } as CircleLayerStyle,
  label: {
    textField: ['get', 'label'],
    textSize: 12,
    textOffset: [0, 1.1],
    textAnchor: 'top',
    textColor: '#1B2236',
    textHaloColor: '#FFFFFF',
    textHaloWidth: 1.5,
    textOptional: true,
  } as SymbolLayerStyle,
};
const HITBOX = { width: 28, height: 28 };
type Filter = NonNullable<ComponentProps<typeof CircleLayer>['filter']>;
const CHARGER: Filter = ['==', ['get', 'kind'], 'charging'];
const NOT_CHARGER: Filter = ['!=', ['get', 'kind'], 'charging'];

/** Fuel stations (price of the chosen grade), EV chargers (from zoom 13.5) and MTMD traffic cameras (D64). Tap opens the point sheet. */
export const PoisLayer = memo(function PoisLayer() {
  const router = useRouter();
  const pois = useApp((s) => s.pois);
  const grade = useApp((s) => s.settings.fuelGrade);
  const on = useApp((s) => s.settings.mapPois);
  const shape = useMemo(() => {
    const now = Date.now();
    return {
      type: 'FeatureCollection' as const,
      features: (on ? pois : []).map((p) => {
        const price = p.prices?.[grade];
        // Only fuel carries a map label (its price); charger power is on the sheet.
        const label = price ? formatC10(price.c10) : '';
        const old = price ? now - price.at > POI_TUNING.staleMs : false;
        return {
          type: 'Feature' as const,
          id: p.id,
          properties: { id: p.id, kind: p.kind, color: COLOR[p.kind], label, op: old ? 0.5 : 1 },
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        };
      }),
    };
  }, [pois, grade, on]);
  const press = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const id = e.features[0]?.properties?.id as string | undefined;
      if (id) router.push({ pathname: '/poi/[id]', params: { id } });
    },
    [router],
  );
  return (
    <ShapeSource id="pois" shape={shape} onPress={press} hitbox={HITBOX}>
      <CircleLayer id="poi-dots" slot="top" minZoomLevel={11} filter={NOT_CHARGER} style={S.dot} />
      {/* A Montréal 0.5° cell holds ~600 OSM chargers: only from street zoom. */}
      <CircleLayer id="poi-chargers" slot="top" minZoomLevel={13.5} filter={CHARGER} style={S.dot} />
      <SymbolLayer id="poi-labels" slot="top" minZoomLevel={12.5} style={S.label} />
    </ShapeSource>
  );
});
