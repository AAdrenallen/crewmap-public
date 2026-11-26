import type { ImageSourcePropType } from 'react-native';
import type { HazardType } from '@crewmap/hazards';

/** Waze-style pins, rendered by assets/hazards/generate.mjs. */
export const HAZARD_ICON: Record<HazardType, ImageSourcePropType> = {
  police: require('../../../assets/hazards/police.png'),
  speedTrap: require('../../../assets/hazards/speedTrap.png'),
  camera: require('../../../assets/hazards/camera.png'),
  accident: require('../../../assets/hazards/accident.png'),
  hazard: require('../../../assets/hazards/hazard.png'),
  closure: require('../../../assets/hazards/closure.png'),
  construction: require('../../../assets/hazards/construction.png'),
  jam: require('../../../assets/hazards/jam.png'),
  pothole: require('../../../assets/hazards/pothole.png'),
};
