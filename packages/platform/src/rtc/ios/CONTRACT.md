# iOS: WebRTC direct links
- `react-native-webrtc` supports iOS; `rtc/ios.ts` re-exports `WebRtcLinks` unchanged.
- **Limits:** iOS suspends sockets when backgrounded unless background location/audio keeps the app alive; links
  drop and the router falls back to Nostr automatically.
