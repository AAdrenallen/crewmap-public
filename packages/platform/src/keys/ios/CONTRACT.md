# iOS: SecureKeyStore
- **Native API:** Keychain via `expo-secure-store` (cross-platform), `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- **Note:** Secure Enclave only holds P-256 keys; our Ed25519/X25519 keys (libsodium) are stored as Keychain items, the same model as Android Keystore wrapping (DECISIONS D6).
