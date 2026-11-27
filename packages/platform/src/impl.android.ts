import type { Platform } from './contracts';
import { androidAudio } from './audio/android';
import { androidGeofence } from './geofence/android';
import { androidHaptics } from './haptics/android';
import { androidKeys } from './keys/android';
import { androidLocation } from './location/android';
import { androidMotion } from './motion/android';
import { androidPower } from './power/android';
import { androidScreen } from './screen/android';
import { androidWake } from './wake/android';
import { nativeSodium } from './crypto/android';
import { androidNotifications } from './notifications/android';
import { androidExternalNav } from './externalNav/android';
import { androidNavOverlay } from './navOverlay/android';
import { androidExternalNavStatus } from './externalNavStatus/android';
import { androidMedia } from './media/android';
import { androidPhotos } from './photos/android';
import { WebRtcLinks } from './rtc/android';

export const platform: Platform = {
  os: 'android',
  location: androidLocation,
  motion: androidMotion,
  geofence: androidGeofence,
  keys: androidKeys,
  wake: androidWake,
  audio: androidAudio,
  haptics: androidHaptics,
  power: androidPower,
  screen: androidScreen,
  notifications: androidNotifications,
  externalNav: androidExternalNav,
  navOverlay: androidNavOverlay,
  externalNavStatus: androidExternalNavStatus,
  media: androidMedia,
  photos: androidPhotos,
  sodium: nativeSodium,
  createDirectLinks: (id) => new WebRtcLinks(id),
};
