import * as SecureStore from 'expo-secure-store';
import type { SecureKeyStore } from '../contracts';

/** Android Keystore-backed (AES-GCM key in the Keystore wraps each value). Values ≤ 2 KB. */
export const androidKeys: SecureKeyStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
