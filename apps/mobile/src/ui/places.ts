import type { PlaceType } from '@crewmap/shared/places';
import type { IconName } from './screens-common/Icon';

/** List/tile icon per place type (map pins use the PNG glyphs in assets/places). */
export const PLACE_TYPE_ICON: Record<PlaceType, IconName> = {
  home: 'home',
  work: 'work',
  home2: 'home2',
  school: 'school',
  gym: 'gym',
  family: 'family',
  friend: 'friendPlace',
  shop: 'shop',
  restaurant: 'food',
  other: 'pin',
};

export const PLACE_COLORS = ['#5B6CFF', '#FF6B6B', '#FFC845', '#2EC4B6', '#8E44AD', '#30A46C', '#FB8C00', '#1F2937', '#D6409F', '#607089'];
