import { memo, useCallback, useMemo, type ComponentProps } from 'react';
import { CircleLayer, ShapeSource, SymbolLayer, type CircleLayerStyle, type SymbolLayerStyle } from '@rnmapbox/maps';
import { useRouter } from 'expo-router';
import { formatC10, POI_TUNING } from '@crewmap/hazards';
import { useApp } from '../../core/store';

const COLOR = { fuel: '#F97316', charging: '#22A06B', trafficCamera: '#5B6CFF' } as const;

const S = {
  fuelDot: {
    circleColor: '#F97316',
    circleRadius: ['interpolate', ['linear'], ['zoom'], 10.5, 5.5, 14, 8.5, 17, 11],
    circleStrokeColor: '#FFFFFF',
    circleStrokeWidth: 2.4,
    circleOpacity: ['get', 'op'],
    circleEmissiveStrength: 1,
  } as CircleLayerStyle,
  dot: {
    circleColor: ['get', 'color'],
    circleRadius: ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 8],
    circleStrokeColor: '#FFFFFF',
    circleStrokeWidth: 2,
    circleOpacity: ['get', 'op'],
    circleEmissiveStrength: 1,
  } as CircleLayerStyle,
  fuelPrice: {
    textField: ['get', 'priceLabel'],
    textSize: ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 12.5, 17, 13.5],
    textFont: ['DIN Pro Bold', 'Arial Unicode MS Bold'],
    textOffset: [0, 1.05],
    textAnchor: 'top',
    textColor: '#0B0F1A',
    textHaloColor: '#FFFFFF',
    textHaloWidth: 2.2,
    textHaloBlur: 0.3,
    textAllowOverlap: false,
    textOptional: false,
    symbolSortKey: ['get', 'sortKey'],
  } as SymbolLayerStyle,
  fuelBrand: {
    textField: ['get', 'brandLabel'],
    textSize: 11,
    textFont: ['DIN Pro Medium', 'Arial Unicode MS Regular'],
    textOffset: [0, 1.05],
    textAnchor: 'top',
    textColor: '#1B2236',
    textHaloColor: '#FFFFFF',
    textHaloWidth: 1.8,
    textOptional: true,
  } as SymbolLayerStyle,
};
const HITBOX = { width: 36, height: 36 };
type Filter = NonNullable<ComponentProps<typeof CircleLayer>['filter']>;
const FUEL: Filter = ['==', ['get', 'kind'], 'fuel'];
const PRICED_FUEL: Filter = ['all', ['==', ['get', 'kind'], 'fuel'], ['!=', ['get', 'priceLabel'], '']];
const UNPRICED_FUEL: Filter = ['all', ['==', ['get', 'kind'], 'fuel'], ['==', ['get', 'priceLabel'], ''], ['!=', ['get', 'brandLabel'], '']];
const CHARGER: Filter = ['==', ['get', 'kind'], 'charging'];
const CAMERA_POI: Filter = ['==', ['get', 'kind'], 'trafficCamera'];

/** Fuel stations (always showing quick small Regular price on the map, fallback to chosen grade or brand), EV chargers, and MTMD cameras. */
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
        // Map shows Regular gas price for quick comparison at a glance (falling back to preferred grade if Regular is absent, e.g. diesel-only).
        const regPrice = p.kind === 'fuel' ? (p.prices?.regular ?? p.prices?.[grade]) : undefined;
        const priceLabel = regPrice ? `⛽ ${formatC10(regPrice.c10)}¢` : '';
        const brandLabel = p.kind === 'fuel' && !regPrice ? `⛽ ${(p.brand ?? p.name ?? '').slice(0, 14)}`.trim() : '';
        const old = regPrice ? now - regPrice.at > POI_TUNING.staleMs : false;
        // Cheaper stations sort higher so Mapbox keeps their price label visible first when zoomed out.
        const sortKey = regPrice ? regPrice.c10 : 9999;
        return {
          type: 'Feature' as const,
          id: p.id,
          properties: { id: p.id, kind: p.kind, color: COLOR[p.kind], priceLabel, brandLabel, sortKey, op: old ? 0.65 : 1 },
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
      <CircleLayer id="poi-cams" slot="top" minZoomLevel={11.5} filter={CAMERA_POI} style={S.dot} />
      {/* A Montréal 0.5° cell holds ~600 OSM chargers: only from street zoom. */}
      <CircleLayer id="poi-chargers" slot="top" minZoomLevel={13.5} filter={CHARGER} style={S.dot} />
      <CircleLayer id="poi-fuel-dots" slot="top" minZoomLevel={10.5} filter={FUEL} style={S.fuelDot} />
      <SymbolLayer id="poi-fuel-brand" slot="top" minZoomLevel={12.5} filter={UNPRICED_FUEL} style={S.fuelBrand} />
      <SymbolLayer id="poi-labels" slot="top" minZoomLevel={11} filter={PRICED_FUEL} style={S.fuelPrice} />
    </ShapeSource>
  );
});
