import { memo, useCallback, useMemo, type ComponentProps } from 'react';
import { CircleLayer, Images, ShapeSource, SymbolLayer, type CircleLayerStyle, type SymbolLayerStyle } from '@rnmapbox/maps';
import type { ImageSourcePropType } from 'react-native';
import type { Place, PlaceType } from '@crewmap/shared/places';
import { useApp } from '../../core/store';
import { onMapboxImageMissing } from '../../core/errorLog';

/** White type glyphs drawn on the coloured disc (assets/places/generate.mjs). */
const GLYPH: Record<PlaceType, ImageSourcePropType> = {
  home: require('../../../assets/places/home.png'),
  work: require('../../../assets/places/work.png'),
  home2: require('../../../assets/places/home2.png'),
  school: require('../../../assets/places/school.png'),
  gym: require('../../../assets/places/gym.png'),
  family: require('../../../assets/places/family.png'),
  friend: require('../../../assets/places/friend.png'),
  shop: require('../../../assets/places/shop.png'),
  restaurant: require('../../../assets/places/restaurant.png'),
  other: require('../../../assets/places/other.png'),
};
const IMAGES = Object.fromEntries(Object.entries(GLYPH).map(([k, v]) => [`pl-${k}`, v]));

const OWNER_COLORS = ['#E5484D', '#FB8C00', '#30A46C', '#2EC4B6', '#5B6CFF', '#8E44AD', '#D6409F', '#1F2937'];
/** Stable per-friend colour for the owner badge on their shared places. */
export function ownerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return OWNER_COLORS[h % OWNER_COLORS.length]!;
}

/** Metres → px at zoom z (512 px tiles), latitude-corrected. */
const px = (m: number, lat: number, z: number) => m / ((156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z / 2);

type Filter = NonNullable<ComponentProps<typeof CircleLayer>['filter']>;
const FRIEND_FILTER: Filter = ['==', ['get', 'friend'], true];
const S = {
  ring: { circleRadius: ['interpolate', ['exponential', 2], ['zoom'], 10, ['get', 'r10'], 20, ['get', 'r20']], circleColor: ['get', 'color'], circleOpacity: 0.1, circleStrokeColor: ['get', 'color'], circleStrokeOpacity: 0.45, circleStrokeWidth: 1.5, circlePitchAlignment: 'map' } as CircleLayerStyle,
  disc: { circleColor: ['get', 'color'], circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 9, 15, 14], circleStrokeColor: '#FFFFFF', circleStrokeWidth: 2.5 } as CircleLayerStyle,
  glyph: { iconImage: ['get', 'icon'], iconSize: ['interpolate', ['linear'], ['zoom'], 10, 0.38, 15, 0.6], iconAllowOverlap: true, iconIgnorePlacement: true, iconPitchAlignment: 'viewport' } as SymbolLayerStyle,
  badge: { circleColor: ['get', 'ownerColor'], circleRadius: 7, circleStrokeColor: '#FFFFFF', circleStrokeWidth: 1.5, circleTranslate: [11, -11] } as CircleLayerStyle,
  initial: { textField: ['get', 'initial'], textSize: 9, textColor: '#FFFFFF', textTranslate: [11, -11], textAllowOverlap: true, textIgnorePlacement: true } as SymbolLayerStyle,
  name: { textField: ['get', 'name'], textSize: 12, textOffset: [0, 1.6], textAnchor: 'top', textColor: '#1B2236', textHaloColor: '#FFFFFF', textHaloWidth: 1.5, textOptional: true } as SymbolLayerStyle,
};

/** Place pins (D28: memoised, constant styles; only the shape changes when places change). */
export const PlacesLayer = memo(function PlacesLayer({ onPress }: { onPress: (p: Place) => void }) {
  const places = useApp((s) => s.places);
  const me = useApp((s) => s.me?.deviceId);
  // Select only owner initials as a primitive string so friend GPS fixes never rebuild the Places GeoJSON.
  const ownerInitials = useApp((s) =>
    s.places.map((p) => (s.allFriends[p.owner]?.profile.name ?? '').slice(0, 1).toUpperCase()).join('|'),
  );
  const shape = useMemo(() => {
    const initials = ownerInitials.split('|');
    return {
      type: 'FeatureCollection' as const,
      features: places.map((p, i) => {
        const friend = p.owner !== me;
        return {
          type: 'Feature' as const,
          id: p.id,
          properties: { id: p.id, color: p.color, name: p.name, icon: `pl-${p.type}`, r10: px(p.radiusM, p.lat, 10), r20: px(p.radiusM, p.lat, 20), friend, ownerColor: ownerColor(p.owner), initial: initials[i] ?? '' },
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        };
      }),
    };
  }, [places, me, ownerInitials]);
  const press = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const id = e.features[0]?.properties?.id as string | undefined;
      const p = useApp.getState().places.find((x) => x.id === id);
      if (p) onPress(p);
    },
    [onPress],
  );
  return (
    <>
      <Images images={IMAGES} onImageMissing={onMapboxImageMissing} />
      <ShapeSource id="places" shape={shape} onPress={press} hitbox={HITBOX}>
        <CircleLayer id="place-ring" slot="top" minZoomLevel={14.5} style={S.ring} />
        <CircleLayer id="place-dots" slot="top" style={S.disc} />
        <SymbolLayer id="place-glyphs" slot="top" style={S.glyph} />
        <CircleLayer id="place-owner" slot="top" filter={FRIEND_FILTER} style={S.badge} />
        <SymbolLayer id="place-owner-initial" slot="top" filter={FRIEND_FILTER} style={S.initial} />
        <SymbolLayer id="place-names" slot="top" minZoomLevel={13} style={S.name} />
      </ShapeSource>
    </>
  );
});

const HITBOX = { width: 28, height: 28 };
