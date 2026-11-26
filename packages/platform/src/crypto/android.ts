import * as libsodium from 'react-native-libsodium';
import type { Sodium } from '@crewmap/p2p';

/** react-native-libsodium (JSI) implements the libsodium-wrappers API subset our Sodium interface declares. */
export const nativeSodium = libsodium as unknown as Sodium;
