# iOS: WakeChannel
- **Native API:** APNs. A device token is obtained with `expo-notifications` `getDevicePushTokenAsync()`; silent pushes (`content-available: 1`) give ~30 s of background time, rate-limited by iOS.
- **Gateway (to build with the port):** APNs needs a server holding the .p8 key. Interface in `packages/p2p/src/transport/apnsGateway.ts`: `POST /ping { token }` → forwards a content-free silent push. Host as a Cloudflare Worker (free tier) or on the PC relay.
- **Limits:** silent pushes are throttled (a few per hour); no headless JS without background modes `remote-notification` + `fetch` (set). UnifiedPush doesn't exist on iOS.
