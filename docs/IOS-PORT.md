# iOS port checklist

Everything above `packages/platform` is shared TypeScript and runs unchanged on iOS (UI, state, map, navigation,
stats, scoring, P2P protocol, crypto, CRDTs, hazard adapters). The iOS work is: native adapters, a tiny push gateway,
Apple account + signing, and store plumbing. `app.config.ts` already carries the iOS bundle id, Info.plist strings and
background modes. Follow the steps in order; each names the contract to implement.

## 0. Prerequisites (owner)
- [ ] Mac with current Xcode, CocoaPods; Apple Developer Program membership (US$99/yr — **costs money**).
- [ ] Create App ID `app.crewmap` with capabilities: Background Modes (location, fetch, remote notifications, audio),
      Push Notifications. Create an APNs auth key (.p8) and note Key ID + Team ID.

## 1. Native adapters (`packages/platform/src/<capability>/ios.ts` + Swift where noted)
Each folder has `ios/CONTRACT.md` with the API and limits. Create `src/impl.ios.ts` mirroring `impl.android.ts`.
- [ ] `location/ios.ts` — reuse expo-location task code; two-step When-In-Use → Always prompt; no FGS notification.
- [ ] `motion/ios.ts` + Swift in the Expo module: `CMMotionActivityManager` (startActivityUpdates, last activity,
      confidence low/medium/high → 33/66/100); IMU via expo-sensors (unchanged).
- [ ] `geofence/ios.ts` — expo-location geofencing; cap to the **20** nearest regions; re-register on significant change.
- [ ] `keys/ios.ts` — expo-secure-store (Keychain), unchanged.
- [ ] `wake/ios.ts` — APNs device token via `expo-notifications.getDevicePushTokenAsync()`; silent push handler runs
      `registerHeadlessSync` handler via a TaskManager remote-notification task. Endpoint format: `apns:<token>`.
- [ ] `audio/ios.ts` — expo-audio/expo-speech (cross-platform); AVAudioSession `.duckOthers` for voice.
- [ ] `haptics/ios.ts`, `crypto/ios.ts`, `rtc/ios.ts` — re-export the Android files (libraries are cross-platform).
- [ ] `power/ios.ts` — no battery exemption on iOS: return true / open app Settings; expo-battery + expo-network.
- [ ] `screen/ios.ts` — protectedData available/unavailable notifications (unlock/lock) in Swift; weaker
      phone-handling signal (documented in DECISIONS D17).
- [ ] Add `"apple"` platform + `"modules": ["CrewmapPlatformModule"]` to `packages/platform/expo-module.config.json`
      and an `ios/CrewmapPlatform.podspec`.

## 2. Push gateway (content-free pings)
- [ ] Interface: `POST /ping { endpoint: "apns:<token>" }` → APNs `content-available: 1`, `apns-push-type: background`,
      `apns-priority: 5`. No payload content, no circle data. Rate-limit 1/min per token.
- [ ] Host on Cloudflare Workers (free tier: 100k req/day) with the .p8 key as a secret, or as a route on `relay/`.
- [ ] In `apps/mobile/src/core/network.ts` `ntfyWake.ping`: if `endpoint.startsWith('apns:')` POST to the gateway URL
      (`CREWMAP_APNS_GATEWAY` in `.env` → `extra`).
- [ ] Limit: iOS throttles silent pushes (a few per hour); the 15-min periodic sync becomes iOS BGAppRefresh (best effort).

## 3. Build + test
- [ ] `npx expo prebuild --platform ios && npx expo run:ios` on a device (simulator lacks motion/background location).
- [ ] Run `pnpm test` (shared) + Maestro flows (`apps/mobile/.maestro`, iOS supported by Maestro).
- [ ] Battery benchmark on an iPhone (Developer → Transport benchmark); add results to `docs/P2P-BENCHMARK.md`.

## 4. Distribution
- [ ] EAS Build or Xcode archive with the Apple team; TestFlight internal testing for the friend group (≤ 100 testers,
      no App Review for internal). App Store review only if ever needed (privacy nutrition label: location linked to
      user = no server collection; data stays on device / E2E).

## Known iOS limits (summary)
20 geofences; silent pushes throttled; no UnifiedPush; Ed25519 keys in Keychain (Secure Enclave is P-256 only);
background WebRTC drops when suspended (router falls back to Nostr); Activity confidence is coarse.
