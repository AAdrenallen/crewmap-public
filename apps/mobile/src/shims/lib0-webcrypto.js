// lib0 (used by Yjs) imports isomorphic-webcrypto on React Native; we only need getRandomValues, which
// react-native-get-random-values installs on globalThis.crypto. Yjs never uses subtle crypto.
import 'react-native-get-random-values';

export const subtle = globalThis.crypto && globalThis.crypto.subtle;
export const getRandomValues = (arr) => globalThis.crypto.getRandomValues(arr);
