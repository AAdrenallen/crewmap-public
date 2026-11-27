# Decisions

Each entry: decision, why, and what would make us revisit it. Newest at the bottom.

**D1 — Expo SDK 58 / React Native 0.88 / Hermes, New Architecture.** Current stable (npm `latest` 2026-11-23). Local
Gradle builds via `expo prebuild` + `npx expo run:android`; EAS only if local builds become impossible.

**D2 — Mapbox for tiles, Directions `driving-traffic`, Matrix, Search Box.** Free tier covers ~20 users with room to
spare (RESEARCH.md). Search uses Search Box `/forward` + `/suggest` billed **per request** (25k free) rather than
sessions (2.5k free); debounced at 350 ms and min 3 characters. Friend ETAs use Matrix (one request per refresh, ≤ 25
coordinates), refreshed only when a friend moved > 300 m or 5 min passed. No Navigation SDK: we build the guidance UI
from Directions data (needed for F11, and its free tier is 100 MAU / 1k trips). Revisit: MAU > 20k or a pricing change.

**D3 — Direct transport: WebRTC data channels, not Hyperswarm.** `react-native-webrtc` works under Expo with a config
plugin on both platforms and runs inside our location foreground service. Bare/Hyperswarm adds a second JS runtime and
worklet bundle and must stop I/O when backgrounded, which defeats background presence. Signalling over Nostr
(encrypted), public STUN only, **no TURN** (it costs money). When direct can't connect, Nostr carries the message.

**D4 — Store-and-forward: Nostr.** `nostr-tools`; default relays `relay.damus.io`, `nos.lol`, `relay.primal.net`,
`nostr.mom`, `offchain.pub` (all advertise NIP-40). Every message is published to ≥ 3 relays.
- Live location / emotes / signalling: ephemeral kind `21420` (relays don't store ephemeral kinds).
- Durable sync (Yjs updates), arrivals, reports: regular kind `1420` with NIP-40 `expiration` (7 days) so offline
  peers catch up.
- Authors are rotating per-circle pseudonymous keys: `HKDF(circleEpochKey, "nostr-author" || day)`, so relays can't link
  days or circles to devices. Tag `#t` = `HMAC(epochKey, "topic" || day)` truncated, so only members can subscribe.

**D5 — Wake-ups: UnifiedPush via ntfy.sh, content-free.** While sharing, the foreground service already holds Nostr
subscriptions open, so wake-ups are only for paused/backgrounded phones. If a UnifiedPush distributor (ntfy app) is
installed, we register a random per-device topic `up<32 random hex>` and peers POST an empty "sync" ping. Otherwise a
WorkManager periodic sync (15 min, the Android minimum) catches up. The topic URL is shared only inside the circle (E2E).

**D6 — Circle crypto: epoch keys with sender signatures (sender-keys style), not MLS.** ≤ 20 members.
- Device identity: Ed25519 signing key + X25519 box key (libsodium), private keys wrapped by `expo-secure-store`
  (Android Keystore AES-GCM; iOS Keychain). iOS Secure Enclave only supports P-256, so it isn't used for Ed25519.
- Circle state is a signed membership log (admin-signed add/remove ops, hash-chained).
- Content key: a 32-byte random `epochKey` per epoch, sealed (`crypto_box_seal`) to each current member's X25519 key.
  Removing a member starts a new epoch; the removed member never receives its key, so they can't read new data.
- Messages: `XChaCha20-Poly1305-IETF(epochKey, nonce=random24, aad=circleId||epoch||kind)` over
  `{senderDeviceId, sentAt, payload, sig=Ed25519(sender, …)}`. Recipients reject non-member or removed-member signers.
- Why not MLS: `ts-mls` is unaudited and needs WebCrypto/HPKE that Hermes lacks; a native OpenMLS binding is heavy
  work for a 20-person group. Trade-off: forward secrecy is per epoch, not per message. Epochs also rotate weekly.
- Revisit: group > 50 or a need for per-message forward secrecy.

**D7 — CRDT: Yjs.** Pure JS on Hermes (Automerge needs WASM). One `Y.Doc` per circle; updates encrypted (D6),
persisted in SQLite, exchanged as state-vector diffs on reconnect.

**D8 — Local storage: expo-sqlite.** First-party, both platforms. Raw location/trip history never leaves the phone,
except in the owner's own encrypted backup.

**D9 — Location, activity and geofencing.** `expo-location` + `expo-task-manager` (location-type foreground service).
Activity Recognition (Transition API) is a custom Expo module in `packages/platform/android`. Geofencing uses the OS API
(`expo-location` geofencing → `GeofencingClient`) with our own enter/exit hysteresis (dwell 60 s, exit margin
radius + 50 m).

**D10 — Waze adapter.** Honest requests to `live-map/api/georss` (bbox around the route/viewport, ≤ 1 req / 2 min /
area, only while someone in the circle drives or has the map open), schema-validated with zod. Public reports say the
endpoint now returns 403 to automated clients; if so, health = `blocked`, the in-app admin screen shows it, and hazards
come from the other sources. No captcha solving, proxy rotation or token spoofing.

**D11 — Paid Waze fallback (off by default).** Adapter for the OpenWeb Ninja Waze `alerts-and-jams` API
(~US$0.005 / request per its public pricing as cited in RESEARCH.md; 100 free / month), with a hard monthly cap
(`WAZE_PAID_MONTHLY_CAP_USD`, default 0 = disabled). At 1 req / 2 min of driving, 1 h/day/driver ≈ 900 req/month/driver ≈
US$4.50/month/driver before the cap. Only the circle's elected chore peer calls it, to share cost.

**D12 — No Google Maps police adapter.** No public or legitimate route exists (RESEARCH.md).

**D13 — Central relay = a tiny Nostr relay.** `relay/` implements NIP-01 + NIP-40 (Node, SQLite, Docker Compose). Moving
a function to the PC is a config change that swaps that function's relay list to the PC's URL. The relay holds no
keys and sees only ciphertext. Exposed via Tailscale Funnel or a Cloudflare Tunnel, never by opening router ports.

**D14 — Toolchain lives in `D:\Tools\CrewMap\.tools`** (portable Node 24, JDK 17, Android SDK, Blender); caches in
`.cache/` (npm, pnpm store, Gradle). C: has < 10 GB free. `tools/env.ps1` / `tools/env.sh` set PATH, JAVA_HOME,
ANDROID_HOME, GRADLE_USER_HOME.

**D15 — Health data merge plan (deferred).** When Health Connect/HealthKit import lands: import only `steps`/
`distance` sessions whose time range doesn't overlap an app-tracked walk/trip (interval-tree on start/end, ±2 min);
overlapping intervals keep the app-tracked record and mark the health record `shadowed`.

**D16 — Passenger override removes the whole trip from scoring** (not only phone-handling events): a passenger's
speed and braking aren't theirs either. `markPassenger()` → score null; stats exclude passenger trips.

**D17 — Phone-handling signal on Android.** Apps can't observe touches in other apps without an accessibility service
(which we won't use). Signal = screen unlocked + interactive while moving ≥ 15 km/h, plus touches inside CrewMap outside
the driving UI. Documented limit; iOS has an even weaker signal (unlock events only).

**D18 — Wake-ups for non-sharing phones.** ntfy (UnifiedPush) binds to our PushService, which counts as "foreground" for
Android background-start rules, so we start a 25 s headless JS sync task (CrewmapSync). If Android refuses, a
content-free notification appears. Periodic catch-up via expo-background-task (WorkManager, ≥ 15 min).

**D19 — Per-friend precision without N× events.** Approximate friends get a broadcast snapped to a ~1 km grid; precise
friends additionally get one event sealed with a per-sender key (`sender-key`, acked unicast, rotated when the precise
set changes). Common case (all precise) = one event.

**D20 — Windows build fixes.** (a) CMake 3.31.6 (ninja 1.12.1 supports > 260-char paths) via `local.properties
cmake.dir` (config plugin `withCmakeDir`); (b) `react-native-libsodium` passes a backslash path into CMake → pnpm patch
`patches/react-native-libsodium@1.7.0.patch`; (c) compile/target SDK from Expo SDK 58 defaults (compileSdk 37);
(d) Mapbox Android SDK downloads without a secret token now (verified anonymous 200 from the Maven repo), so only the
public `pk.` token is needed.

**D21 — Relay storage on Node's built-in `node:sqlite`** (no native deps; runs with `--experimental-strip-types`, so
relay code is erasable-syntax-only TypeScript).

**D22 — Waze fixture.** The contract-test fixture follows the documented Live Map shape (public projects) because live
requests were blocked from this machine; a capture script replaces it once a live request succeeds (F4c live smoke test
stays "unverified" until then).

**D23 — Paid Waze cost.** OpenWeb Ninja `GET /waze/alerts-and-jams`: US$0.003/request via their agent storefront
(US$0.03 per 10), ~US$0.005 on direct pay-as-you-go. Budgeted at US$0.005 in code (`PAID_COST_USD_PER_REQUEST`).

**D24 — CI minutes.** The repo is private: GitHub gives 2,000 free Actions minutes/month on 2-vCPU/7 GB runners.
`ci.yml` (lint, typecheck, tests, simulator, relay in Docker ≈ 3 min) runs on every push; `android.yml`
(debug + release native builds, ≈ 60–90 min each, swap added to fit 7 GB) runs only when app/native code changes or on
demand. At ~10 native-touching pushes a month that's ~1,500 min — inside the free tier; GitHub's default $0 spending
limit means it stops rather than bills if exceeded. Local builds on the PC remain the primary path.

**D25 —  Waze / Google Maps ETA via Notification Access.** Neither app exposes a data API to other apps, and
reading their screen through an AccessibilityService breaks their ToS and Play policy. While guiding, both post an
ongoing navigation notification (remaining time, distance, arrival, next maneuver); with the user's Notification Access
grant, `NavStatusListener` (NotificationListenerService) reads it. Privacy: the listener drops every notification whose
package is not `com.waze` / `com.google.android.apps.maps` or that is not an ongoing navigation one, before touching its
content; matching ones are forwarded raw to JS only while the app is running (nothing is persisted or queued) and are
parsed in place (`shared/navigation/externalNavParse.ts`). Only the derived arrival time + source app leave the phone,
inside the existing E2E presence `eta` (`etaSrc` marks it). No iOS equivalent (CONTRACT.md).

**D26 — Multiple crews + per-crew sharing policy.** Each crew keeps its own circle log, epoch keys, Yjs doc and
Nostr topics (one `CircleManager` + `Network` per crew in `core/crews.ts`); the device mailbox is one subscription
shared by all crews and dispatched by `circleId`. Tracking / hazards / emotes talk to a network-shaped facade
(`Crews`) so they did not need to know about crews. A `SharingPolicy` per crew (`packages/p2p/src/sharing.ts`:
location exact / ~2 km / ~20 km city / hidden; speed+driving status; battery; stats; trips; places+arrivals; emotes;
default = everything on, exact) is enforced only on the sending side, before sealing: presence via
`PresencePublisher.publish(…, { policy })` (hidden = the ghost marker; coarse = one broadcast, no precise channel),
profile/stats via `profileForPolicy` per crew doc, shared places only into docs of crews with places on, arrivals and
emotes routed only through a crew whose policy allows them (incoming ones from a crew we don't share them with are
ignored), own hazard reports skip hidden crews. Ghost mode stays global; per-friend precision still applies inside an
exact crew. A friend in several crews is shown once, merged by deviceId: most precise / newest position, unioned
fields — i.e. the most permissive data they shared with any crew we have in common. Leaving: admins (not the owner)
remove themselves so keys rotate; otherwise the crew is forgotten locally until an admin removes us. Migration: circle
logs and Yjs updates were always keyed by circle id, so only the kv index moves (`circleId` + `invites` →
`crews.v2` + `invites:<id>`, default policy), done once at load and idempotent; the old keys are left in place.

**D27 — Navigation voice: system TextToSpeech, mixed-language segments.** Spoken guidance uses the Android system
TTS engine (Google Speech Services) through our Kotlin `NavTts`: one engine bound at module start (binding costs
more than the ~300 ms start budget, synthesis afterwards is ~50–150 ms), offline voices only
(`!isNetworkConnectionRequired`, not `notInstalled`), `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` and transient may-duck
focus held over the whole queue, plus the existing expo-audio `duckOthers` mode. Neural on-device models were rejected
for now: Supertonic 3 covers en/fr/ru but its weights carry an OpenRAIL-M licence and the company is reported (unconfirmed)
to be dissolving with the repo archived; Piper/sherpa-onnx VITS voices are good but add ~60–75 MB per language and a
cold ONNX start; Kokoro has no Russian. The system engine is zero-APK, low-power and already tuned for the device.
Each instruction is split into segments (`navigation/nameLang.ts`): template words in the voice language, road/place
names (from step name, refs and banner text components of the current, next and following steps) in the language they
are written in (cue-word classifier; Cyrillic → ru; bare route numbers → voice language; ambiguous → French inside a
rough Québec outline, else English). Segments are queued with `QUEUE_ADD` and a per-utterance `Voice`, so they play
back-to-back. A "Voice language" setting (en/fr/ru, default = app language) drives both TTS and the Mapbox Directions
`language` (banners follow it too). A missing system voice is detected (`voiceStatus`); Settings offers the system
install screen once per language and speech falls back to English meanwhile. The UI gained a full `ru` locale.

**D28 — Map render path while navigating.** `CrewMapView` subscribes only to rarely-changing values (route,
candidates, nav active, driving, hasFix); the self marker, friend markers, hazards, places and ramp highlight are
memoised children with narrow selectors, so a fix re-renders only the self sprite. Every layer style, filter,
`StyleImport` config, `followPadding` and `defaultSettings` is a constant or memoised (new objects made the native
side re-apply them, and re-applying the Standard config looked like a map reload on each rotate). `onCameraChanged`
is gone: it ships the full camera state to JS every frame while following. A native `CameraGestureObserver`
(`maxIntervalMs` 500) drives gesture detection, the viewport and the sprite bearing (two `getCoordinateFromView`
calls), stored in a tiny `useMapBearing` store read only by markers. Camera rotation stays native
(FollowWithCourse moving / FollowWithHeading stopped, hysteresis 3 / 1.5 m/s). The fresh-hazard pulse is a static
halo. While navigating, Standard `show3dTrees` and `show3dFacades` are off (buildings, landmarks and raised bridge
decks stay); terrain exaggeration 1.4 → 1.15. Not measured on device yet. Avatars stay RN `MarkerView`s: a symbol
layer would need the baked sheets sliced into per-heading images and loses the reanimated bounce; with a handful of
markers this is not the bottleneck. `hazardsOnRoute` / `incidentsAlong` use a chunked bbox index
(`polylineChunks`), and `slicePolyline` binary-searches its start.

**D29 — One smoothed position source for camera and markers.** `MotionSmoother` (`packages/shared/src/motion.ts`)
dead-reckons from the last fix with speed, clamped acceleration and turn rate (CTRV), or along the route polyline
when navigating and matched (≤ 30 m, reported course within 60°); extrapolation stops 1.5 s past the fix or below
1 m/s; a new fix blends the shown-vs-predicted error out over 450 ms (ease-out, heading the short way; > 150 m snaps).
At each next 1 Hz fix (replay fixtures, `tools/replay/test/motion.test.ts`) the mean/max error goes from 24.7/32.0 m
(hold) to 2.0/4.8 m on the highway drive (the 2 m fixture jitter is the floor), 14.3/16.7 → 0.2/5.0 hard brake,
20.7/30 → 0.2/2 speeding, 10.6/11.1 → 0.1/2 sharp turn, and 13.8/13.9 → 0.0/0.0 on the matched two-turn route.
The app runs it on fix time (`core/replayClock.ts` scales it during dev replays) and publishes a pose at 10 Hz while
moving or blending into `useSelfPose`, read only by `SelfLocation` (an rnmapbox `CustomLocationProvider`, which the
native follow camera tracks instead of the platform provider) and `SelfMarker`. The custom provider sends a bearing,
not a course, so heading-up uses `FollowWithHeading` always and JS picks the bearing (`BearingSelector`): GPS course
above 3 m/s, compass below 1.5 m/s, cross-faded over 600 ms. The compass (`platform.location.watchHeading`, expo-location
`watchHeadingAsync`, true north else magnetic, low-accuracy readings dropped) runs only while heading-up and in the
foreground; `CompassFilter` low-passes it the short way (τ 300 ms), ≤ 10 Hz, ≥ 2° steps.
Option B (MarkerView fed from the pose) over a native puck: the puck would need a new top-down bake and drops the
pitched 3D sprite look; one marker at 10 Hz is cheap. Friends use the same smoother (6 s cap, 900 ms blend) on
receipt time, ticking at 4 Hz per marker only while moving. No per-fix bounce while driving. Dev replays pace fixes on
an absolute timeline (`offset / speedup`), so processing time never stretches the cadence.
*Amended after device test:* switching speakers mid-sentence (en-US default → fr-CA name) was jarring. Default is now
one speaker per utterance: the Canadian voice of the voice language (en-CA / fr-CA / ru-RU, specific installed voice,
local + highest quality; English without en-CA is matched to the fr-CA speaker's gender hint and tier). Name-language
detection only adjusts spelling (French abbreviations like "St-" → "Saint-" expanded, accents kept). Mixed speakers
remain opt-in ("Names in their own voice"), with voices paired by gender/tier.

**D30 — Place types, pins and per-place × per-crew sharing.** A place has a free-text name (≤ 40, enforced in
the editor) and a `type` (Home, Work, Second home, School, Gym, Family, Friend's place, Shop, Restaurant, Other) that
only sets the icon and default colour. Own places carry `sharedWith: circleId[]`, default none (privacy-first). A place
reaches a crew only if it lists that crew AND the crew's "Places & arrivals" policy is on; enforced on the sending side
by `applyPlaceSharing` (`shared/places/sharing.ts`), which writes the wire form (no `sharedWith`, so crews never learn
our other crews) into allowed crew docs and deletes it from all others. Arrivals and "driving home" go only through
crews whose doc holds the place (`arrivalCrews`, `sendTo(…, via)`). `icon`/`visibility` stay as derived fields for
older peers. Migration: legacy shared → every crew with places on at load, private → none; persisted once. Map pins:
data-driven colour disc + white PNG glyph (`assets/places/generate.mjs`), name from z13, radius ring from z14.5,
owner badge (initial, stable colour) on friends' places; constant styles (D28). Search matches accent/case-insensitive
name prefix > word prefix > substring > type name in en/fr/ru.

**D31 — Drive-along and deeper friend features.** A drive-along session (`shared/companions/session.ts`, pure) has
one organiser and invitees (a friend, a pick of friends or a whole crew) who accept, decline or ignore it (an invite
lapses after 15 min). It ends when the organiser stops it, nobody is left, companions go silent for 10 min, 8 min after
my drive ends, or after 12 h. Joined members send live presence (`presence-live`) only to one another: every 1.5 s
while driving, 10 s otherwise. It is driven by the store's fix updates, never a new GPS mode, and it is non-durable,
not acked and never wakes anyone. Session ops (`drive-along`), shared route lines (`route-share`, ≤ 300 points,
withdrawable), "ask for location" (`loc-request`) and live ETA shares (`eta-share`) are new router kinds.
Each payload is box-sealed to its recipient (`p2p/companions.ts`), so other crew members who see the relay event
cannot read it. `Crews.companionSend` picks the first crew shared with the recipient whose policy allows the kind, and
builds the payload with that crew's policy. Drive-along and routes need `location: exact` (and no ghost mode); locate
needs any location; ETA needs speed. The same check filters incoming messages. A locate request is answered by one
normal presence publish (`Tracking.publishNow`), so all policy, ghost and per-friend precision rules still apply,
limited to once a minute per requester. Protocol 3 adds the caps `driveAlong` / `locate` / `etaShare`. The UI offers
a feature only when `peerSupports` is `true` (null counts as old, so acked ops are never retried at old builds).
Render path (D28): live positions live in their own `useCompanionLive` store. `CompanionOverlay` (strip + edge blips)
recomputes at ≤ 4 Hz from its own interval: native `getPointInView` via `ui/map/projector.ts`, then
`edgePlacement`/`spreadBlips` (pure, tested). When the projection fails at high pitch, the bearing relative to the
camera is used instead. The safe rect excludes the banner, strip, speed badge, report button and footer. The map tree
only gains `CompanionRoutes` (constant style, changes about once a minute). Voice cues (`CompanionCues`: gap buckets
1/2/5/10/20 km with a 3 min cooldown, "different route" after 30 s off my route) are spoken only with voice `on`.
Regroup = the first of my places ahead (≥ 2 km) within 150 m of both routes. Receiver-side extras: battery-low alerts
(< 15 %, re-armed at 30 % or when charging), and one-shot arrival subscriptions (`once`), deleted by the subscriber
after they fire.

**D46 — Group drive ("Drive together").** A drive-along session may carry a destination picked by the host
(`session.dest`, `destRev`, `arrived`, `pendingDest`; pure in `shared/companions/session.ts` + `group.ts`).
Same router kind (`drive-along`, sealed per recipient, acked), same `v: 1`, new optional fields and ops (`dest`,
`arrive`); builds without capability `groupDrive` (512, protocol 5) ignore the extras and unknown ops, so they read it
as a plain drive-along invite. The picker only offers peers with `groupDrive`, and names the reason for the others
("Needs app update", "Location sharing is off" when no shared crew allows exact location). Flow: friend card / long-press
"Drive together" or a crew → `/search` (destination) → `/route` ("Invite crewmates") → `/drive-along` picker (preselected
with the crewmate I started from) → invites. Invitees get a notification plus `GroupDriveCards`: a card when browsing,
a pill with one-tap Join while driving (`noticePolicy('groupDrive')`: deferred right before a turn, never a modal). Join =
accept + the Navigator's preview/start to the host's destination. The strip shows each member's ETA (their own nav ETA
from the live presence, else a straight-line guess) or "Arrived" (distance ≤ 75 m, not "navigation ended"). Host changes
the destination from route preview ("Use as group destination"): members get a Go / Keep prompt. A leaving host hands
over to the joined member with the smallest id (every peer computes the same, no message); "End for everyone" is `stop`.
Live presence stops for me 5 min after I arrived, and when the drive ends; when all arrived a summary card lists order
and clock times. Root cause of "drive-along does not work": `tick` took `parkedSince` from the last drive of the day, so a
drive-along started while parked ended on its first tick (5 s) and withdrew the invites; invites were only visible on a
hidden screen; the capability stamp could be lost when crews merged presence; stationary members sent no live
position at all (live sends were only driven by fix changes).
## D32 — Production performance pass (2026-11-24)
- **Metro `inlineRequires: true`**: modules (three.js/avatar baker, charts, WebRTC, dev code) initialise on first use
  instead of at bundle start. Expected: 10–30 % faster TTI and lower startup JS heap; no UX change.
- **Minifier `pure_funcs` = console.log/info/debug** (release only): removes log formatting cost on hot paths.
  `console.error`/`console.warn` are kept, so `core/errorLog.ts` routing still works.
- **`useActiveInterval` (ui/useActiveInterval.ts)**: map light-preset (CrewMapView), hazard fresh-halo minute tick,
  walking sprite step (220 ms → ~4.5 renders/s per walking friend) and crewmate-sheet refresh now stop while the app
  is backgrounded and catch up once on resume. Expected: zero JS wake-ups from these timers in background.
- **MotionSmoother windowed track match** (shared/motion.ts): the per-fix route match searches 20 segments behind /
  200 ahead of the last match before falling back to a full scan. Bench, 7.5k-pt route: 572 → 16 µs per fix.
- **Mapbox telemetry off** (`setTelemetryEnabled(false)`): no event collection/uploads; privacy and radio.
  Tile cache left at the SDK default (disk-bounded by Mapbox); layers are all data-driven and conditionally mounted.
- **Sprite sheets**: URI cache LRU-capped at 48 and concurrent bakes of one config deduped. Decoded bitmaps
  (avatar 3072×576 ≈ 7 MB, car 3072×192 ≈ 2.4 MB) are shared per URI by the native image cache, which evicts on
  its own. A low-res distant variant needs a second bake per config, so it is deferred until device numbers call for it.
- **Selectors**: audit found no `useApp` selector returning a fresh object/array; reducers return primitives.
- **Deferred**: React Compiler (`experiments.reactCompiler`; Babel auto-configured from SDK 54). Enable it only
  after a device regression pass. Targeted `memo` already covers the map layers.
- Device check: `bash tools/device/perf-snapshot.sh` (startup, PSS/RSS, per-thread CPU, gfx jank).

**D40 — No Waze Live Map requests (supersedes D10).** The Live Map `georss` endpoint is a web page's private API with
bot protection; calling it from the app is scraping, whatever the request rate. The adapter is no longer wired
(`HazardService` has no live-map dependency, `wazeEnabled` defaults to false and is ignored); its parser stays only
so older peers' shared `waze` records still parse. The paid OpenWeb Ninja fallback (D11) is a third-party resale of
Waze data whose licence from Waze is not public: it stays off (cap 0) until the owner has checked its terms. Police
data now comes from crew reports, the anonymous network (D41) and MTMD events (cause "policier"). Google Maps / Waze
notifications (D25) carry ETA only, never police.

**D41 — Anonymous public hazard network (opt-in publish, default receive).** `packages/hazards/src/anon.ts`. A report
is a Nostr event (kind 1421, NIP-40 expiry = type TTL, ≤ 6 h) signed by a fresh secp256k1 key used once, with content
`{v, t, c, h}` only: type, geohash-7 cell (~150 m), heading sector of 8, `created_at` rounded to 2 min; tags `t`
(`crewmap-hz`), `g` (geohash-4 topic, ~40 × 20 km), `cap` (`crewmap-hz/1`, the version), `expiration`, NIP-13 `nonce`.
No device, crew, profile, exact position or exact time. Votes ("still there?") are the same shape with
`{v, vote}` and an `e` tag, also one-shot keys. Subscriptions use the gh4 cells along the route (≤ 12), so relays learn
the region, not the road. Abuse resistance: 16-bit proof of work on every event; acceptance caps (3 per cell + family
per 10 min, 60 per topic cell); one vote per key, ≤ 20 per report; local publish limit 1/min, 10/h, 30 votes/h;
readers reject unknown versions, extra content keys, a TTL longer than the type's, or a cell outside its topic. Crew
copies record `anonId` so a report seen both ways counts once; own events are remembered locally and never announced.
Publish is OFF until the user enables "Share my reports anonymously: no name, crew or exact spot"; receive is ON.
Relays still see the connecting IP, as for all Nostr traffic: the copy does not claim more. Uses the shared relay
pool and the public relays, never the crew topics. Potholes are not published (they would live for weeks).

**D42 — Hazard fusion and confidence.** `confidence.ts`. Reports are de-duplicated by type family, distance (+ the
anonymous cell radius) and time (merge.ts). Each independent report (one per friend device, per anonymous event, per
feed) has a probability (official 0.95, Mapbox 0.85, friends 0.8 ± votes, anonymous 0.4 ± votes) combined noisy-OR,
then decayed with age (police: full for 15 min, half-life 30 min). Anonymous-only clusters are capped at 0.55
(medium) unless two reports are ≥ 2 min apart. Levels: high ≥ 0.6, medium ≥ 0.35. `MergedHazard` exposes
`confidence`, `level`, `fade` (marker opacity ≥ 0.3) and `mix` (independent reports per source) for the hazard sheet.
Police and speed traps are spoken only at `high`; other types at `medium` (existing rules: no own reports, ≥ 150 m).

**D43 — Best route for the moment, continuously.** `shared/navigation/reevaluate.ts` + `Navigator.maybeReevaluate`.
While navigating: a check every 5 min, every 2 min when the last fresh response showed a jam (congestion_numeric ≥ 60,
heavy/severe, or live speed < 40 % of the limit over ≥ 300 m) or an incident ahead, and early (≥ 90 s apart) when a new
accident / closure / jam hazard appears on the corridor; none in the first 2 min, within 5 min / 2 km of arrival, or
beyond 40 per trip. A check is one Directions call with alternatives (same exclusions); when none of them follows the
remaining route, a second call prices it with 3 silent vias. All routes are scored by `recommend` (control delays,
learned corrections, habit tie-break). Offer when the best saves > max(2 min, 8 %), and either ≥ 2× that or seen at
two consecutive checks; never onto a closed road; a dismissed alternative is suppressed 10 min; the offer
auto-dismisses after 20 s; `settings.autoSwitchFaster` switches instead. State: `nav.faster` (FasterOffer);
actions `acceptFaster()` / `dismissFaster()`. Requests add `congestion_numeric,speed` annotations. Cost: 1.5 h/day of
navigation, a check every ~3.5 min, half of them needing the second call, 2 previews and 1 reroute a day ≈ 2 800
Directions requests per driver per month (`monthlyDirectionsEstimate`), so ~35 drivers fit in the 100 k free tier.

**D44 — More MTMD layers, conditional GET, state-tied polling.** Added `ms:evenements_inondation` (flood closures /
restrictions) and `ms:conditions_routieres` (winter surface + visibility; only non-normal segments become `hazard`
records with the condition as description, so the route preview and drive UI show them as route-condition warnings).
Every official feed goes through `withConditionalGet` (ETag / Last-Modified; 304 served from cache). Per layer:
events every 5 min while someone drives (15 otherwise), works and conditions every 20 min, photo radars every 6 h,
Montréal every 6 h; nothing while the whole crew is idle. Only the elected chore peer fetches, for the route bbox
(else viewport / crew), and shares over P2P. Other open feeds checked: the MTMD WFS also lists cameras (images only,
not hazards) and weather stations. A stable live entraves feed for Ville-Centre / Highlands municipalities was not found in this pass; none added.

## D33 — Battery: viewer demand + radio governor (2026-11-24)
- **Still means no GNSS**: the still tier is LOW_POWER at 5 min. Movement comes from AR transitions and a 150 m
  "here" exit geofence. AR sampling drops to 120 s and the housekeeping tick to 120 s.
- **Viewer demand** (protocol 4, `viewerDemand` cap, `watch` kind): background presence slows (driving 15 s, walking
  2 min, still 15 min) unless a friend has the app open; a friend opening it gets one fresh fix. Older builds always
  count as watching.
- **Radio governor**: backgrounded + still for 3 min, with nothing un-acked and no drive-along, closes all relay
  sockets and WebRTC links. Wake-ups via ntfy/WorkManager (same path as a dozing phone), and reopening replays from
  last-online. The simulator's idle-8h now models this: delivery unchanged, 20 % fewer relay events.
- A durable message already delivered directly keeps one relay copy, not three. `Router.stop` now closes direct links.
- The map's follow camera runs only in the foreground: its Mapbox location provider kept GNSS at 1 Hz in the background.
- Rejected for now: dropping the location FGS while still (no headless restart path yet), and patching
  expo-location for maxUpdateDelay batching (native change; deferred until device numbers).

**D45 — Friend drive times: demand-driven Matrix refresh.** `shared/etaRefresh.ts` (`planEtaRefresh`, `displayEtaS`),
driven from the housekeeping tick (`Tracking.refreshEtas`) and the friend card. Replaces "every 2 min or 300 m,
foreground or driving".
- **Only where shown**: map in the foreground (screen on); the Waze / Maps overlay (shown friends only, half rate,
  ≥ 2 min); nothing backgrounded without the overlay or with the screen off. Plain background driving no longer queries.
- **Adaptive staleness**: both still means no re-query; the last answer stays. Otherwise 30 s per straight-line km,
  clamped 1–15 min (near friends, where minutes matter, refresh more). Movement beyond max(300 m, 10 % of the
  distance) re-queries early. At most one batched call per 30 s, with only the due friends in it.
- **Friend card open**: that friend re-queries at once if anyone is moving and the value is > 20 s old.
- **Free numbers first**: a drive-along friend whose shared route ends within 300 m of me shows their own nav ETA and
  is never queried. Between calls the shown number is dead-reckoned: routed ETA + (straight-line change since the
  query × the routed s/m factor), from the P2P positions of both ends.
- **Budget** (Matrix free tier 100k elements/month; one element per due friend): typical active user ≈ 10 min of map
  time plus 1 h overlay drive a day, 3–5 friends: ≈ 15–40 calls, ≈ 40–80 elements a day, ≈ 2k/month. The old
  policy was ≈ 30 calls/h whenever the app was open or the user drove, with every friend in each call. The free tier
  covers ≈ 40 such users. Worst case (map open, a near friend driving): ≈ 60 calls/h.

**D47 — "Ask location" = "where do you want me?", plus "Ask to share once" (protocol 6, `askWhere`).** Pure logic in
`shared/companions/ask.ts` (state machine, rate limit, expiry), app side `core/asks.ts` + `core/asksStore.ts`, UI
`ui/drive/AskCards.tsx`, friend screen / card / long-press menu, search screen in answer mode.
- **Replaces** the old "ask location" (`loc-request`: asked a friend to publish a fresh presence). The kind and its
  handler stay so older builds that still send it are answered; this build no longer sends it.
- **One wire kind** `where-ask` (acked, durable, 30 min relay TTL), ops `ask` / `answer` / `share` / `decline`, each
  box-sealed to the one recipient like 1:1 chat. Carried by any crew policy (it holds no location itself).
- **where**: the recipient gets a card ("<Name> asks where you want them"), answers with a saved place, search result,
  current location or a dropped pin, plus an optional 80-char note. The asker gets "<Name> wants you at <place>" with
  Navigate / Drive together (route preview with the crewmate preselected, so it rides D46) / Dismiss.
- **once**: for crewmates whose policy shows me nothing (no presence), a coarse position, or ghost. The friend stays
  in the deck / sheet / friend screen with "Location not shared" and "Ask to share once". The recipient picks Share
  15 min / 1 h / Decline (or Decline and mute). The share bypasses the standing policy for that request only: it is
  honoured only against a pending ask of mine, clamped to 1 h, and the position is wiped at expiry on both sides
  (20 s tick, also on load). It overlays the friend's presence (precise, "Shared once · expires in N min").
  "Until I arrive" was left out: it needs a destination and arrival tracking on the sharer's side.
- **Anti-spam**: one pending per pair and kind, 10 min cooldown (sender refuses, receiver drops), unanswered asks lapse
  after 30 min; "Decline and mute" / "Mute asks" on the friend screen drops all asks from that friend silently.
- **Driving**: `noticePolicy('ask')` = a pill while moving (Here / Share 15 min / Navigate, never a modal), deferred
  before a turn, same as group drive. Notifications go silent while driving.
- **Compat**: peers that know their version lack the bit show "Needs app update". A friend who hides their location
  sends no presence, so their build is unknown and the ask is tried (acked ops simply lapse after 30 min).

**D48 — Riders on rides; cheaper sprite bakes.** The avatar now rides their vehicle on the map (the wire field stays
`car`; the UI calls it "Ride"). Fifteen rides: the six closed cars (panoramic see-through glass; the rider at half the
walking size, head through the roof so they stay recognisable at 64 dp), convertible (head and shoulders out, free arm waving), motorcycle (astride, hands on the bars, leaning in),
the hot dog (kept: open cockpit, rider pops out of the bun, mustard + ketchup, windscreen, chunkier wheels),
skateboard (standing sideways, arms out), kick scooter, rocket (astride, leaning), shopping cart (hands up), clawfoot
bathtub (arms on the rim, rubber duck) and magic carpet (cross-legged, waving). `build_assets.py` writes each ride's
map scale, seat (rider hip), rider scale and pose (hip/shoulder pivot angles, lean, yaw) to `manifest.json`; the app
(`kit.ts buildRide`) and `tools/blender/preview_rides.py` both read it, so the Blender preview is the pose check.
Compat: `normalizeCar` (shared) maps unknown ids from newer peers to the default model, keeping a valid colour;
older peers fail the bake of an unknown id and keep showing the walking avatar.
Performance (offline proxies; device bake time is logged in `__DEV__` as `sprite bake …`, still to be read on the
phone): meshes joined per part variant × pivot × material in Blender → draw calls per cell 75 → 30 (default look),
cars 46 → 8; avatar sheet 3,600 → 1,440 draws per bake. Toon materials (4-band ramp) replace PBR clear-coat/sheen,
so the per-bake PMREM environment pass is gone. GLBs: UVs dropped (untextured kit), dedup + weld + quantize
(`tools/blender/optimize.mjs`, KHR_mesh_quantization, read natively by GLTFLoader) → 2,009,083 → 1,297,638 B with 7 more
rides. Lists (`AvatarStill`) use a 1-cell portrait (192², ~150 KB decoded) instead of the 3072×576 sheet (~7 MB
each), snapshotted from the walk-sheet bake (no extra bake); the ride sheet is only baked/decoded while a friend drives (before, every marker baked its car sheet on
mount). Old-version sheets are deleted on the first bake of a launch.
Rejected: pre-baking atlases on the PC (the composed config space — parts × colours × rides — is far too large;
on-device per-config bake stays); Draco / EXT_meshopt_compression (need a WebAssembly decoder, which Hermes does not
have); KTX2/Basis (the kit has no textures); CC0 packs (Kenney car kit, Quaternius characters): textured palette
atlases break the single `paint` recolour material, and realistic rigs do not fit the chibi part-variant kit, at
64 dp the outline/shading/pose matter more than mesh detail. Symbol-layer markers instead of `MarkerView`s stay
deferred (D28): worth it only past roughly 15–20 visible friends and needs device numbers first.

**D49 — Custom quips; jokey friend-facing tone.** Emote presets, their popups/combo/streak texts and emote
notifications now use a cheeky biker-announcer voice (en/fr/ru, original lines only; ids, testIDs and preset sounds
unchanged; the tone applies only to friend interactions). Any crewmate can create a quip (voice <= 6 s, emoji, image or
GIF, caption <= 32), send it to a friend or the whole crew, and recipients "Save to my quips" (content id, "by <creator>"
kept) and re-send it. Transport (`packages/p2p/src/quips.ts`): content-addressed blobs (BLAKE2b-128). Total <= 20 KB
travels inline in the sealed `quip` message; bigger quips add `quip-blob` chunks of 16 KB (events stay ~30 KB, under the
~64 KB many relays enforce), reassembled in any order with hash verification, 72 h relay expiry (kinds
`quip` acked, `quip-blob` not). Receivers skip chunks for blobs they hold (saved quips are never re-downloaded); senders
skip blobs already sent to a friend. Limits: image <= 80 KB, GIF <= 250 KB, audio <= 60 KB / 6 s, whole quip 330 KB;
3 sends/min, 6 quips and 90 chunks per sender per minute accepted. Blob store: app documents dir, 30 MB LRU (blobs of
saved quips evicted last), metadata in kv. Crew sharing policy: both kinds follow `emotes`. Protocol 7, capability
`quips` (2048): older peers get the voice clip as a plain custom emote (text/emoji/image-only quips reach nobody there).
Driving: received quips follow the emote policy (popup pill only; sound only if allowed, ducked); "Save" only when
stopped. Image picking uses the already-installed expo-document-picker; with no on-device encoder (no
expo-image-manipulator), over-limit images are refused rather than compressed. Rejected: unsealed/public blob hosting.

**D50 — One-link invites: rolling preview APK + static join page.** The share text is the crew name plus one https
link, `https://aadrenallen.github.io/crewmap-public/join/#<token>` (GitHub Pages, `site/join/index.html`, orphan
`gh-pages` branch of the public repo). The token stays in the URL fragment, which browsers never send; the page loads
nothing (CSP `default-src 'none'`, no-referrer), decodes the crew name locally, auto-opens the app via
`intent://join#<token>#Intent;scheme=crewmap;package=app.crewmap.preview;S.browser_fallback_url=…?o=1#…;end` (plus an
"Open" button, since webviews often block intents without a tap) and shows one "Install CrewMap" button to the rolling
asset `releases/download/preview/CrewMap-Preview.apk` (the `preview` release's asset is replaced on every publish).
Tapping Install copies the https invite; the app's onboarding reads the clipboard once (lazy expo-clipboard), stashes
the invite, clears the clipboard and shows "Join {crew}?" first on the crew step: one tap joins, never automatic. Both
link forms are accepted everywhere (`extractInviteLink` normalises to `crewmap://join#…`; `+native-intent` routes https
links to /join); the QR carries the https form so a system camera without the app lands on the install page. Verified
App Links were rejected: a Pages project site cannot serve the host-root `/.well-known/assetlinks.json` (a copy ships
in `site/` for a future user/custom-domain site), so the https intent filter is unverified; on Android 12+ such links
open the browser unless the user enables the domain under "Open by default". Rejected: an install referrer (needs Play),
a URL shortener or our own server (sees the token).

**D51 — Riders never clip their ride.** Closed cars now have a painted roof with a sunroof opening. The rider stands
up through it, and the seat height is computed from the roof (`hip = roof + clearance - chin * k`), so the whole head
is above the roof at every heading. The pose rests one forearm on the roof and waves the other. Bar rides (scooter,
motorcycle) build their grips at the hands computed by the rider forward kinematics (`hand()` in build_assets.py),
so the fists always hold the bars. The shopping cart has a chassis (rails, rear uprights, caster forks and plates).
build_assets.py writes per-part boxes and grips to `tools/blender/rides-geometry.json`, which the app does not
bundle. `avatar-assets.test.ts` mirrors the kit.ts composition and checks that: no head is inside any part box; on
closed cars the chin is above the roof; every part, every wheel included, connects to the body through touching
boxes; and each hand is within 5 mm of its grip. Cars gain plates and an `accent` pinstripe (a separate recolourable
material; `paint` stays the single body colour). Closed-car riders are 0.65 (was 0.48), so they read at map size. Cars also gain A/C pillars, sills, door lines, grille slats and mirror glass, plus a feature per model: hatchback roof spoiler, SUV spare wheel and guard, sports wing and intakes, van sliding-door track, pickup tailgate. Wheel spokes are unbevelled to stay under 4k tris.

## D34 — Short join codes (2026-11-26)
A 6-character code (alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`: Crockford-style without 0/O/1/I/L, 31 symbols,
case-insensitive, shown `ABC 234`) as an alternative to the QR/link, without a server of ours. The admin taps
**Code**: the app mints a dedicated one-time invite valid 10 min, seals its full link with `crypto_secretbox`, and
publishes it as an expiring (NIP-40, 10 min) durable Nostr event on the crew relays plus the public defaults (the
joiner has no relay hints yet). The joiner types the code, derives topic + key, fetches and opens the blob, then
continues through the unchanged link join (`decodeInvite` → `buildJoinRequest` → admin `acceptJoinRequest` →
`completeJoin`), so the admin's phone must be online to answer the handshake, exactly as for links.
- **Derivation.** `master = argon2id(code, salt = BLAKE2b("crewmap-join-code-v1", 10-min bucket))` at libsodium's
  INTERACTIVE limits (the only ones react-native-libsodium exposes); `topic = keyed(master, "code-topic")`,
  `key = keyed(master, "code-key")`. The topic deliberately comes from the pwhash output, not a cheap hash of the
  code: tags are public, and a fast hash over ~30 bits is inverted in seconds. The time-bucket salt stops a one-off
  precomputed table for all codes. The joiner tries the current and previous bucket (plus the next near a boundary for
  clock skew): 2–3 argon2id runs.
- **Single use** is enforced by the one-time invite inside (`pending.used`, 10-min `e`), not by the event. On a
  successful join the admin also publishes a best-effort NIP-09 deletion signed with the event's throwaway key (our
  optional relay does not implement deletion; public relays mostly do). Max 3 live codes per crew.
- **Joiner rate limit:** 5 wrong codes → 60 s lockout (persisted). Malformed input is not counted. This is a UX guard
  only: an attacker does not use our app.
- **Threat model.** 6·log2(31) ≈ 29.7 bits. An online guesser must run argon2id per guess per bucket and query
  relays; within 10 minutes that is far from 2^29 for anyone but a well-resourced attacker. A relay operator (or anyone
  who scrapes the relays) holds the event, but cannot even tell which topic belongs to which code without the
  argon2id work: brute-forcing a captured event costs up to ~2^29.7 × argon2id(64 MiB) ≈ CPU-years, GPU-feasible for a
  determined attacker, and the race only matters if they finish and send a join request before the real joiner
  (single use) within 10 minutes. A winning attacker would appear as a new member the admin can see and remove.
  Codes are therefore for in-person or trusted-channel sharing; links/QR (256-bit secret) remain the strong path.
- **Cost.** argon2id runs synchronously on the JS thread through JSI (~0.3–1 s per run on a mid-range phone,
  unmeasured); the UI yields one frame first so the spinner shows.
- Rejected: a cheap topic hash (inverts the code); constant salt (precomputation); an expensive KDF only for the key
  (topic still leaks the code); a central code→link lookup (a server of ours that sees tokens).

**D52 — Sharing is per crew only, plus per-friend overrides; per-recipient presence tiers.** The global "Friends can
see" (stats visibility) and the per-friend "Precise location" switch are gone. Stats visibility is a field of each
crew's `SharingPolicy` (`statsVis`, shown on the crew's sharing screen under Stats; its `trips` row is folded into the
crew's Trips switch, which already removed trip counts). The full stats summary is computed once and every crew narrows
it (`profileForPolicy` → `restrictShared`). Migration (`migrateSharingGlobals`, flagged by `crews.v2.ver = 3`, runs
once in `Crews.load`): the old global visibility becomes the value of every crew without an explicit `statsVis`; an old
"approx" friend becomes an override `{ location: 'approx', speed: false }` (what approx used to strip); then the legacy
keys are dropped from persisted settings (`splitLegacySharing`).
- **Overrides** (`UserOverride`: location, speed — which still covers heading/activity/ETA —, battery, drive-along) are
  keyed by friend deviceId and resolved as `override ?? crew policy` (`resolveShare`) in every crew that carries that
  friend, so a restriction cannot leak through a second crew's merge. Companion kinds (drive-along, live presence,
  ETA share, locate) were already box-sealed per recipient; they now get the resolved policy (`driveAlongAllowed`:
  explicit override, else exact location only).
- **Presence**: `planPresence` takes the crew policy and the members' resolved views. No overrides (or overrides equal
  to the crew) = exactly today's single broadcast, no extra sends. Otherwise the crew broadcast carries the floor (the
  least any member may see; hidden = the one-time ghost marker) and each richer view becomes a tier: one
  'presence-tier' secretbox event per update per tier, under a tier key that is `crypto_box_seal`ed to each tier
  member's box key ('tier-key', durable + acked, rotated when the tier's members change). Cost: one extra event per
  distinct tier, only while overrides differ from the crew. The receiver merges a tier and the broadcast of the same
  fix (same `t` and precision) instead of letting the later one wipe fields.
- **Compatibility**: capability `userShare` (4096), protocol 8. Builds without it never get a tier: a grant to them
  falls back to the crew level; a restriction still holds (they only read the broadcast, which is lowered) — so while
  someone in a crew is restricted, older builds in that crew also see the lowered level. Unknown peers are tried.
- **Not per friend**: stats, trips, places, hazard reports and emotes/chat stay crew-level (a Hidden override does stop arrival/departure/driving-home messages to that friend). Stats/places live in the crew-wide Yjs doc,
  where a per-member restriction cannot be enforced without per-recipient profile sealing.
- **Old precise channel**: the pre-D52 'sender-key' was sent through the router's crew-epoch envelope, so any member
  could read it (the per-friend precision was cosmetic against a modified client). New senders no longer use it;
  receivers still read it from older senders.
- The first-time "each crew has its own sharing level" banner is removed from the crew sharing screen (it showed
  above the location options); the tip stays on Settings → Tips.

**D53 — Emotes: Crew Radio voice, edge pop-ins, ride mutes.** Preset emotes now speak an original gruff "Crew Radio"
biker-announcer persona (`tools/voice/lines.json`, en/fr/ru, 2 variants each, <= 2 s; no lines or audio from any game or
real person) synthesised offline with Piper (MIT) and public-domain/CC0 voices, pitched down with saturation, radio EQ
and a short slap reverb (`tools/voice/build.mjs`), mono Opus 20 kbps, ~160 KB with the stings; the old chiptune WAVs are
gone. Non-verbal stings (horn, whoosh, pop, cheer) layer under the voice; combos and live streaks escalate the sting
volume and rate (pitch) per layer, capped (`EDGE_AUDIO`), with a cheer finale. Presentation is Life360-style: emoji pop
in from the side edges and top/bottom in a staggered, bouncy cascade that grows with the count (<= 80 pieces, UI thread,
deterministic per emote id), plus a sender chip (avatar, name, xN). The planner (`shared/emoteBurst.ts`) never places
pieces or the chip on the occupied layout rects (top banners, speed, footer, MsgBlips column). Driving: two soft edge
pops and the chip only, voice ducked and only when allowed, no stings. Ride mutes (`shared/rideMutes.ts`): "Mute
{name}" (chip x or long-press, emote screen chip) and "Mute all" (chip bell, emote screen chip; a bell-off badge undoes
it while driving) silence emotes, quips and chat notices until the ride ends (navigation ends, or 5 min not driving).
Muted emotes still reach the friend log and are counted into the friend's emote digest. Rejected: imitating any
existing voice; on-device TTS for presets (voice quality and offline availability vary by phone).

**D54 — Two-colour looks: optional trims, lens colour, natural ride materials.** Audit: hair ties, top trims (jersey
collar/cuffs/number, hoodie strings, jacket pockets), bottom stitching/stripes, hat bands/pompoms/rims, extra straps
and chains, all lenses and most ride secondary parts were fixed colours; glasses had no finish; the cart basket, the
skateboard wheels and the scooter stem ignored the ride colours. Now: each fixed trim of a slot is its own
`<slot>2_<name>` material and one optional trim colour per item (`trim.{hair,top,bottom,hat,accessory}`) repaints them;
unset, every style keeps its built-in trims (hair ties and hat bands keep the auto accent). Optional `lens` (`#RRGGBB`
or `clear`): dark lenses (`lens_dark/mirror/neon`) take the colour as is, tinted ones (`lens_tint/pink/amber/red3d/
blue3d`) blend 0.6 toward it, the new clear lenses of open frames (round, wire, square, nerd, catEye, monocle) blend
0.3 and stay see-through; `clear` turns every lens see-through (opacity 0.25, no glow). `glasses` joined
`FINISH_ITEMS` (frame). Rides: `accent_<name>` parts (rims, seats, chrome frames, gold trims, tub rim) take the
optional accent, unset they keep their look; `paint_<name>` natural materials (hot dog bun, wooden skateboard deck,
rug) stay natural until the rider picks a paint colour (`tint: true`, blend 0.5). Every ride now has an accent. All new
fields are optional, so old payloads parse and old peers ignore them; no new palette slots (an old build's
`isAvatarConfig` still passes). Rejected: palette slots per trim (a default would repaint existing looks) and a `clear`
finish (finishes are wire-global and would also show for car paint). Old skateboard and carpet looks change from the
paint colour to the natural deck/rug until re-tinted.

## D55 — Crew clusters and group scenes on the home map (2026-11-26)
Friend markers closer than `CLUSTER.overlapPx` (52 dp; 64 while driving/navigating) on screen merge into one cluster
(single-link, `packages/shared/src/crewCluster.ts`). Screen points come from `getPointInView` when the camera settles
(existing CameraGestureObserver) or presence changes, throttled to 400 ms: no per-frame work, no onCameraChanged.
Tap: our own Web-Mercator fit (`fitZoom`, padded, capped at `maxZoom` 19) then `setCamera`, because rnmapbox
`fitBounds` has no max zoom and over-zooms on near-identical points; at max zoom the tap opens a list sheet whose rows
are the existing `LiveRow` and open the usual crewmate screen. Members within `sameSpotM` (25 m, same building) draw a
group scene: frozen cells of each member's EXISTING walk sheet (3 frames x 16 headings) placed by 2D transforms,
from a generated library (`groupPoses.ts`: 12 formations x 5 frame patterns x 4 leans x mirror, deduped; >=100 per
count 2..8), picked by FNV-1a of sorted member ids. Rejected: a new 3D group bake (cost, bake time per combo);
Mapbox ShapeSource clustering (works on symbol layers, our markers are RN MarkerViews with baked sprites).

## D56 — Per-friend sharing: Same as crew | Custom, stats overridable (2026-11-26)
- A friend's sharing is a two-way segmented control: **Same as crew** (no override; a read-only summary of what they
  see now: location level + the crew that grants it, speed, battery, stats) or **Custom** (a full `UserOverride`).
- Several shared crews: each crew sends its own `override ?? crew` data, so the summary is the most permissive crew
  (`shareSummary`, packages/p2p/src/shareSummary.ts); the location level names that crew.
- Switching to Custom pins every override field to what the friend sees now (`customFromSummary`), so nothing changes
  until a toggle does; back to Same as crew clears the override (`setOverride({})`), same persistence and re-publish.
- Mode is derived, not stored: override present => custom (`shareUserMode`).
- Stats became overridable per friend (`stats`, `trips`, partial `statsVis` on `UserOverride`) because the stats
  aggregate is sealed per recipient; `statsAllowed(resolvedPolicy, group)` is the one gate the sender calls. Places,
  emotes and chat stay crew-wide (crew Yjs doc / crew channel).
- Crew screen and Custom share one component (`ui/share/ShareFields.tsx`): location segmented, data switches, stats
  fields. Older peers ignore the new override fields (they are local only).

## D57 — Leaderboard aggregates and the You | Leaderboard stats tab (2026-11-26)
- **Headline stats** are km driven and km walked for the selected period (calendar week Monday-based / calendar month /
  all time, local time zone, existing `periodStart`). The active-day streak stays computed and shared (old peers and the
  weekStreak badge depend on it) but is shown only as a minor line.
- **Leaderboard data** is a new content-minimal `stats-agg` message (protocol 9, cap `statsAgg` = 8192): per period, only
  counts and totals (`packages/shared/src/stats/aggregate.ts`): drives, km driven/walked, walks, longest km, score +
  scored km, events/100 km, night/early starts, distinct places, home leaves/returns, no-hard-brake streak, plus a
  period key `k` so receivers drop last month after rollover. No routes, places, ids or coordinates.
- **Policy**: built per recipient and box-sealed to that friend (like companions), every field group passed through
  `statsAllowed(effective(crew, friend), group)` (D56) before sealing. Stats off = nothing sent. Home counts got their
  own visibility group `home` (default off) since they reveal routine. Receiver re-validates with a strict whitelist.
- **Cost**: event-driven only (start, maintenance every 6 h, after a saved drive, on policy change); per-peer dedup,
  unchanged payloads resent at most daily, at most one flush a minute; a member heard from for the first time this
  session gets ours once (late joiners, no polling). Known older builds are skipped; unknown kind is ignored by them.
- **Categories**: driven, walked, longest trip, drives, best score and smoothest (both need ≥ 20 km), no hard brakes,
  home runs, night owl, early bird, places. No top speed (don't reward speeding). "Time with the crew" skipped: no data
  source exists. Ties share a rank, order by km then id. A friend without a current aggregate, or hiding a group, is
  simply absent from that card.

## D58 — Friendly pings, smart quick picks and the catch-up fanfare (2026-11-26)
- **New presets without a protocol bump**: 7 pings (thinking of you, I'm here, need a ride?, welcome home, charge up,
  drive safe, you rock). On the wire they go out as their nearest legacy preset plus `p2` (`toWire`/`fromWire`):
  older builds validate and show the fallback, newer builds read `p2`, and an unknown `p2` from a future build degrades
  to the fallback. No capability bit needed, so `protocol.ts` is untouched. Pings reuse their fallback's voice lines
  and sting (no new audio).
- **Picker**: one vertical ScrollView is the formSheet's only scroller (detents 0.7/1). Root cause of the thin, stuck
  "Recent": the old layout put a flex:1 ScrollView between fixed siblings (mutes, banners, record button) in a 0.6 sheet;
  on Android the sheet only hands drags to a nested-scroll child, so the outer list never scrolled and only the inner
  nestedScrollEnabled Recent list did. Recent is now a horizontal snap row of chips (who · what · when, tap to resend).
- **Quick picks** (`shared/emoteSuggest`): reply to their last emote, their place moment (arrive home → welcome home),
  low battery (when shared) → charge up; while they drive only the driving-safe set. Favourites = long-press pins, then
  presets sent ≥ 2× in 30 days. ×1/×3/×5 bursts (one at a time to a driving friend). Two-way daily streak chip.
- **Notifications**: sent at receive time when not foreground (a JS timer may never fire in the background), one per
  sender with a running count and last 3 emoji; actions Send back + two quick pings; the notification is dismissed
  after an action; "Send back" before the engine runs is kept in the outbox.
- **Catch-up**: seen keys persisted (a relay replay after a cold start never re-celebrates), quips join the queue,
  one card per sender in a root box-none layer (works when opened from a tap onto another screen), tap to skip, Skip
  for all; driving/navigating: tiny toast, sound only under the existing driving-sound rule.

## D59 — Route chooser: corridor probes, road-class costs, corridor labels, colours, minimum fit span (2026-11-26)
- **Root causes (owner report: a back-street shortcut recommended over the motorway and the regional road).**
  (1) Discovery split on unplausible base routes (a long out-of-the-way alternative took two of three splits) and at
  peak hours never probed the motorway corridor: Directions' own 1–2 alternatives were both regional-road variants, and
  sibling-exit / divergence vias filled every slot with near-copies of one corridor. A forced via on the motorway came
  back within a few minutes of them. (2) `fastRoadM` classified each whole step by its first intersection, so steps
  entered by a ramp counted as non-motorway (base motorway route measured ~0.54 instead of ~0.85), weakening the tie-break.
  (3) The tie-break ignored time inside the band: a route ~3 min slower won on 1–2 fewer lights. (4) Labels compared each
  route with its closest twin, so two motorway variants differing only near the door were named by the last street,
  bare refs ("50") were shown, and a ref-less step of a numbered highway counted as a different road.
  Learned habit (up to 5 trips × 60 s) on the owner's phone may also have contributed; it is not visible off-device.
- **Discovery** (`DISCOVERY.callBudget` 8 → 10): splits and probes seed only from plausible base routes; two corridor
  probes run with the splits: *avoid* = the fastest base route again with `exclude=point(lng lat)` on its longest
  mid-route step (results that pass within 60 m of the point are dropped: an ignored exclusion), *stay* = at the first
  motorway/trunk exit with ≥ max(5 km, 15 %) of the trip left, a bearing-constrained silent via 800 m down the mainline
  (cached at the point the route really passed). Tilequery was tried and dropped: it only sees one tile.
- **Selection**: end zones (max(1 km, 10 % of length) ≤ 8 km) are ignored for a second distinctness test; routes that
  differ mid-route go first, then at most one end-only variant; the quickest route with ≥ 40 % motorway keeps a slot.
- **Ranking** (`CANDIDATES.recommend`): `expectedS` (ETA: live + control allowance × learned correction) is unchanged;
  ranking uses `costS` = expectedS + 10 s/km local street + 4 s/km collector + 5 s/left turn + 3600 s on a closed
  incident + the app's hazard cost (`routeHazardCostS`: closure 900 s, crash 120 s, works 45 s, hazard 30 s, pothole
  5 s × confidence, police/cameras 0, cap 1800 s, direction-aware). Eligible band = max(150 s, 4 %) + motorway share ×
  120 s; inside it the lowest cost + predictability penalty wins. Off-route reroutes and the in-drive re-evaluation
  use the same `recommend`, re-evaluation decides on `costS`.
- **Labels**: per-intersection road classes and a cross-candidate name → ref map; refs shown the local way (Québec
  "A-n" for 1–99 / 400+, "R-n" for 100–399, direction suffixes dropped; elsewhere as published); end-zone road weighs
  0.2; a numbered / major road carrying ≥ 15 % joins as corridor context ("A-n, A-m", "R-n, Montée …"); texts are
  unique (fallback: the route's two main corridor roads, then a letter). Tags: Fastest, Highway, Fewer turns, No tolls,
  Shortest; each card shows "+N min" vs the fastest and a colour chip.
- **Colours**: alternatives were near-black because Standard-style lighting shades custom layers at dusk / night
  (emissive strength 0 by default) and they were grey. All our route lines now set `lineEmissiveStrength: 1`; each
  candidate has its own non-traffic colour (`ui/map/routeColors.ts`), the selected one wider with a casing and traffic
  colours only on slow stretches; data-driven colours use `coalesce` so a missing property can never render black.
- **Camera fit** (`shared/cameraFit.ts`, `CAMERA_FIT`): fits show at least 300 m each way and never end past zoom
  17.5 (route preview and "show us both"); the crew-cluster tap keeps its D55 max zoom 19 by design.
- **Hazards**: a report whose known heading differs from the route direction by > 120° (other carriageway) is neither
  announced nor priced.
- **Follow-ups**: a re-evaluation offer is decided on `costS` but says / shows only expected-time savings (a closure
  ahead is never announced as "saves 60 min"); hazards Mapbox also reports are not charged (already in its durations,
  and the preview republishes the selected route's incidents, which would bias against that route); of two end-only
  twins the faster is labelled by its corridor and only the slower one by its end roads. Planned works / closures
  that have not started are already dropped by the feeds (Québec 30 min lead, Montréal future starts).

## D60 — ETA truth and Mapbox request budget (2026-11-26, in progress)
- **Evidence.** On public-landmark test trips at a weekday evening, Mapbox `congestion` was "unknown" (no live probe
  data) on 0 % of motorway length, 4 % primary, 21 % secondary, 39 % tertiary and 96 % local street length. A live
  motorway jam is priced, the same jam spilling onto a parallel shortcut is not (historical speeds only), so a
  shortcut is optimistic exactly when it is recommended. `depart_at` runs return no live data at all (predictive only).
  Not proven on the owner's own drives: the last pulled database had no route traces.
- **Ranking** (`shared/navigation/etaBias.ts`, `recommend.ts`): per road group (motorway/trunk, primary/secondary,
  tertiary, local) and period (weekday peak / other) a ridge-fitted multiplier of actual / predicted, shrunk to 1 or to
  crew multipliers; habit drives (past trips vs the router's typical time, no preview needed) and preview samples (now
  with per-group parts and origin→destination leg time from the fixes). Route correction shrinks toward the group
  factor. Peak-only ranking costs: 0.5 σ risk, 8 % of no-live-data time (fades with measured drives); leaving the
  highway at peak needs max(240 s, 8 %) lower cost. Habit bonus off once a route has ≥ 2 measured drives. ETA shown
  changes only with measured drives.
- **Requests**: `shared/apiBudget.ts` daily counters + soft/hard caps (all Mapbox calls via `getJson`); result cache
  (4 min) and discovery modes full / warm (weekly per O/D and period) / lean (`navigation/routeCache.ts`); avoid probe
  skipped when a motorway and another corridor are already found; speed-limit cell cache (`shared/speedLimits.ts`)
  before Map Matching; search answer cache; re-evaluation gated by the budget.
- **Crew**: multipliers ride in the sealed `stats-agg` payload (`eb`, only to friends who may see my stats).

## D61 — OSM fixed cameras via Overpass, no right turn on red on the island of Montréal (2026-11-27)
- **OSM cameras** (`packages/hazards/src/sources/osm.ts`, source id `osm`): nodes `highway=speed_camera` plus `device`
  members of `type=enforcement` relations (`maxspeed | traffic_signals | average_speed | mindistance |
  red_light_camera`) become `camera` hazards (subtype `speed_camera` / `red_light` / `average_speed`, heading from
  `direction` degrees or cardinal). Fills the gap outside Québec (Ontario ASE cameras, red-light cameras, abroad); in
  Québec it merges with MTMD photo radars (60 m camera radius, MTMD ranks first). Licence ODbL 1.0, credit
  "© OpenStreetMap contributors, ODbL" on the hazard sheet and in Help → licences.
- **Load on a volunteer service.** overpass-api.de policy (OSM wiki "Overpass API"): < 10 000 queries and < 1 GB a day
  summed over all users of an app, divide by 100 for regular use, identify the app (User-Agent), back off after
  429/406. We fetch 0.5° cells, each at most once a week, ≤ 4 cells per cycle, only on the chore peer (charging +
  Wi-Fi, someone driving or the map open), exponential backoff 15 min → 24 h with rotation to maps.mail.ru (VK Maps,
  documented "no request limitations, use in any project"). A crew of a few phones makes a handful of queries a week.
  Cells persist on the phone (`osmCameras` kv) and every phone reads its cache with `cached()` (no network); results
  are also shared with the circle. Endpoints are a constructor parameter, so a self-hosted Overpass or the home relay
  (D13) can replace them. private.coffee/kumi was not used (asks for notice for larger projects; its data lagged months).
- **Right turn on red** (`shared/navigation/rightOnRed.ts`): banned island-wide on Montréal (SAAQ "Turning right at a
  red light"; regulation C-24.2, r. 9.1), allowed elsewhere in Québec. Right / sharp-right turns whose maneuver
  intersection has a traffic signal and lies on the island are counted (`controls.noRedRightTurns`) and cost
  `noRedRightS` = 8 s each in ranking only (never in the ETA). The island outline is coarse (~0.5–1 km); posted
  local bans elsewhere are unknown to us.
- **Rejected.** Ontario 511 (`511on.ca/api/v2`): now requires a registered account and per-developer key; its terms
  sit behind the login, so the licence could not be checked: skipped until the owner registers and reads them.
  Environment Canada weather alerts (`api.weather.gc.ca/collections/weather-alerts`, live, en/fr): polygon alerts do
  not fit the point hazard model and need route-overlap UI; deferred. OSM maxspeed / signals via Overpass for routing:
  per-route corridor queries would be heavy Overpass load and Mapbox already returns maxspeed and signals.
  Waze Live Map / scraping: still excluded (D40).

**D62 — Waze Live Map adapter re-enabled (owner decision, supersedes D40).** The owner asked for it again, as the original
spec (F4) required. `HazardService` takes an optional `WazeLiveMapSource`; `fetchWaze` uses it first (default
`wazeEnabled: true`, owner-signed kill switch), and falls back to the paid API (still off, cap 0) only when the live
map is killed or blocked. Kept limits: ≤ 1 request / 2 min / area, only while someone drives or the map is open, bbox of
the route or view, results shared encrypted with the crew, health check (blocked / shape-changed retry ≥ 30 min), "Waze"
attribution and age. No proxies, spoofed tokens or challenge solving: if blocked, it degrades to the other sources.
The endpoint is an undocumented private API and may break or be refused at any time.

## D63 — Crew-sensor insights: road roughness, learned stop delays, leave-by (2026-11-27)
Pure logic in `packages/shared/src/insight/` (tunables in `insight/thresholds.ts`, Vitest `shared/test/insight.test.ts`);
not wired into the app yet.
- **Road roughness / potholes** (`roughness.ts`): the IMU linear-acceleration magnitude the trip pipeline already samples
  is placed on the latest good fix (accuracy 25 m or better, at least 30 km/h, fix at most 2 s old), scaled by
  sqrt(54 km/h / speed) and pooled as RMS per 50 m grid cell. Only cell values are shared, never traces. A spike of
  6 m/s² or more counts toward a pothole suggestion only when 2 or more distinct drivers hit one in the same cell, so a
  dropped phone or one kerb does not create a report. Google and Waze rely on manual reports. Ours come from the crew
  driving past, and nothing they don't already share leaves the phones.
- **Learned stop delays** (`stopDelays.ts`): 5–180 s stops inside drives, pooled per 30 m cell and 3 h band, give the
  median wait once 3 or more are seen. This is meant to replace the fixed per-signal and right-on-red seconds (D59/D61)
  with measured ones where the crew drives. The final park (over 180 s) is excluded.
- **Leave-by** (`leaveBy.ts`): the 80th-percentile duration of the crew's own past trips between two saved places, on
  the same kind of day (weekday or weekend) and within 90 min of the planned start, plus 2 min buffer. Null below 3
  trips, so the caller falls back to the router ETA. It costs no API calls.
Why: these use data only the crew's phones hold, they need no paid source, and they fit the existing pipeline (IMU,
trip traces, places). Next: aggregate the cells in `stats-agg`, feed `expectedStopS` into `roadPenaltyS`, and show a
leave-by chip on place cards.

## D64 — Free map-point feeds: official Québec fuel prices, MTMD traffic cameras, OSM fuel/chargers, optional Open Charge Map (2026-11-27)
New `packages/hazards/src/pois/` (a `Poi` model next to hazards: fuel / charging / trafficCamera; tests
`hazards/test/pois.test.ts` on recorded fixtures), app side `apps/mobile/src/core/pois.ts`, map layer
`ui/map/PoisLayer.tsx`, point sheet `app/poi/[id].tsx`, fuel search `ui/FuelResults.tsx`.
- **Fuel prices: Régie essence Québec (official, station level).** Since 2026-04-01 every Québec retailer must report
  each regular / super / diesel price change to the Régie de l'énergie (Protégez-vous, March 2026: at most 5 minutes
  after the change). The legal basis is cited by a Régie document as art. 67.1 of the Loi sur les produits pétroliers
  (amended by Bill 69, 2025); the article text itself was **not read** (LégisQuébec refuses automated fetches), so
  whether the law also obliges the Régie to publish is unconfirmed: the duty we verified is retailers → Régie, and the
  Régie does publish. The Régie's public map
  (regieessencequebec.ca) reads one file, `https://regieessencequebec.ca/stations.geojson.gz`: ~2 480 stations, name,
  brand, address, postal code, region, per-grade price string ("166.4¢") and availability, `metadata.generated_at`
  (regenerated every few minutes), `Access-Control-Allow-Origin: *`, ETag, `Cache-Control: max-age=60`. It also offers
  an xlsx download of the same data from the map. **No licence text is published** (site, footer, privacy page,
  Données Québec, and the xlsx all checked; LégisQuébec refused automated fetches). We rely on a file the Régie
  itself publishes for download and on its spokesperson's statement (Protégez-vous) that "other third-party players
  will be able to retrieve data, since we make our data available for download"; that is permission to retrieve, not
  an explicit reuse licence. Credit "Régie de l'énergie du Québec — Régie essence Québec" is shown on every station. **Owner to confirm**;
  if terms appear that forbid reuse, drop `RegieFuelSource` from `core/pois.ts`.
  Freshness: records carry **no per-station change time**, so the age shown is the feed's `generated_at` ("as of").
  Load: chore peer only, every 10 min while someone drives or has the map open, `If-None-Match` (304 when unchanged;
  ~130 kB gzipped otherwise); a phone that opens fuel search with prices > 30 min old fetches once itself. Cached in kv
  (`poi.regie`), dropped after 48 h. Prices are integers in tenths of a cent.
- **Combining sources.** Same-kind points within 60 m merge, same-brand fuel within 150 m (measured on a Montréal
  0.5° cell: 380 OSM fuel nodes vs 374 Régie stations, 334 within 60 m, 19 at 60–200 m, 27 further; merge 9 ms for
  ~1 400 points). Régie / MTMD rank first, then crew, OCM, OSM; per grade
  the newest price wins (`newerPrices`), so a future crew price report (backlog #5) newer than the Régie file wins.
- **Sharing.** New router kind `pois` (fn `chores`, durable 1 h, older builds ignore unknown kinds): compact tuples
  (`encodePois`): priced fuel first, then cameras, unpriced fuel, chargers, nearest to the chore peer's
  position first within each group, capped at 30 kB UTF-8 of JSON (sealed + base64 stays under the ~64 kB relay cap), on change or every 30 min. Received copies are
  kept newest-per-id (`SharedPois`, kv `poi.shared`). Same crew-policy gate as `hazards`.
- **Map / search.** Pins from zoom 11 (orange fuel with the chosen grade's price from zoom 12.5, blue cameras), green
  chargers only from zoom 13.5 (one Montréal cell has ~600); prices older than 24 h are greyed. Only listed for a drive-sized area (≤ 1° × 1.5°). Searching
  "gas / essence / station-service / diesel / заправка / АЗС…" shows a fuel block above the normal results: grade
  chips (regular / premium / diesel, saved as `settings.fuelGrade`), Cheapest / Nearest, 15 km radius, from the local
  cache; the Mapbox search is skipped for those generic words. A phone with no fresh (≤ 30 min) price within 15 km
  fetches the Régie file itself once. Settings switch `mapPois` hides the layer.
- **MTMD traffic cameras** (`ms:infos_cameras`, CC-BY 4.0): ~680 cameras (names stored in French), whole layer weekly (~450 kB) on the chore
  peer. The sheet opens the official Québec 511 viewer page (`URL_FLUX_DONNEE`, only `quebec511.info` links kept); we
  do not download or embed the images, which Québec 511 serves under its own terms.
- **OSM fuel + chargers** via the D61 Overpass client, now generalised as `OverpassCells` (`sources/overpass.ts`; the
  camera source uses it too, persisted snapshot shape unchanged): one combined `nwr[amenity~fuel|charging_station]`
  query per 0.5° cell (Montréal cell: 546 kB, 44 s on overpass-api.de, 1 006 points, 164 kB cached), refreshed at
  most every 30 days, `access=private/no` skipped. OSM `fuel:*` price tags are not
  used (rare, unstandardised, undated).
- **Open Charge Map**, optional: only with `OCM_API_KEY` in `.env` (→ `extra.ocmKey`), otherwise `disabled`. Terms
  (openchargemap.org/site/about/terms): user data CC BY 4.0, third-party records keep their provider's copyright, apps
  must show the data-provider attribution and licence. We ask `opendata=true`, also drop records whose
  `DataProvider.License` is not a recognised open licence, and show "provider · licence" per record. Daily per area.
  Not tested live (no key here).
- **Diagnostics.** `ApiKind` gains `overpass`, `regie`, `mtmd`, `ocm` (counted, never capped), shown in Settings → Help →
  Diagnostics; feed health (`regie`, `osm-poi`, `mtmd-cam`, `ocm`) joins the hazard health list.
- **Rejected / not done.** `ms:stations_meteoroutieres` is a frost / thaw depth network (daily `gel`/`degel` metres,
  used for spring load limits), not live road weather: no driver value. `ms:evenements_inondation` was already in
  use (D44). OSM `amenity=parking`: a 0.5° Montréal cell is thousands of features, heavy on a volunteer Overpass;
  skipped until it can be asked for a small area around a destination. Régie daily regional averages: superseded by
  station-level data. NRCan / Statistics Canada fuel prices (city or monthly averages) for outside Québec: not
  implemented; outside Québec there is no free official station-level feed, so stations show without prices.
  GasBuddy / CAA: proprietary, no scraping.

## D69 — Offline crew mesh: narrower scope, BLE convoy beacon, prototype first (2026-11-27)
Study: `docs/MESH-FEASIBILITY.md`. No full mesh. Wi-Fi Direct (seconds of setup and user prompts), Wi-Fi Aware (absent
on the OnePlus 8), Google Nearby Connections (closed SDK that needs Play services) and GATT meshes (links break while
moving) are rejected. Candidate: an Android-only, connectionless, single-hop BLE 5 extended-advertising beacon that
carries a compact (~140 B) sealed presence/emote. It reuses the circle epoch key (AEAD) and the member Ed25519 signature
and adds a rotating sender tag. It runs only during drives, inside the location FGS, as a fallback `proximity` transport
for `presence`/`emotes`. Estimated range 50–150 m (1M), 150–400 m (Coded); battery +0.3–1 %/h. iOS is out of scope
(no ext-adv / Coded control). Gate: a two-car range test on the OnePlus 8 plus a second phone. Go at ≥90 % beacon
delivery at 100 m on Coded, no-go under 50 m. Prototype 2–3 days, production ~1.5–2 weeks.
Why: convoy cars that follow each other stay within ~100 m, so tunnels and short dead zones are covered cheaply. A
separated convoy is out of range of any phone radio, and only LoRa hardware (Meshtastic) would cover that.

## D70 — Road-weather route warning + free trip feeds (2026-11-27)
- Slippery-road warning without crew sensors: ECCC weather-alert polygons (api.weather.gc.ca `weather-alerts`, ECCC
  Data Server End-use Licence, "Data Source: Environment and Climate Change Canada") and the MTMD winter road
  conditions already shared as `quebec:cond:*` hazards, intersected with the active route
  (`packages/hazards/src/roadWeather`). One warning per zone (kept across reroutes), spoken in the alert voice +
  haptic + a 10 s drive banner with the credit line; generic "Hazard ahead" is no longer spoken for condition segments.
  ECCC is fetched by the navigating phone only (route bbox, ≤ 1 req / 15 min): polygons are too heavy for P2P.
  Watches are ignored; statements only when their text mentions icy/slippery roads. Tunables: `ROAD_WEATHER`.
- CBSA border waits (open.canada.ca, OGL – Canada): fetched only when the route bbox contains a QC/ON port; spoken +
  banner once ~30 km before the port, direction-aware (`info/border.ts`, public port coordinates).
- Wikipedia nearby on the place sheet (CC BY-SA 4.0, text only, link + licence line), cached 30 days per ~100 m cell.
- All three have HealthTrackers (`eccc`, `cbsa`, `wiki`) and API-budget counters (Diagnostics).

## D67 — Where did I park (2026-11-27)
- When a drive ends (the existing trip detector: stop dwell or walk-away), the last trip point becomes the parked spot,
  oriented to the last moving heading. Passenger trips never save one; marking a trip passenger forgets its spot.
- Skipped: own saved places of type home / second home (radius + 40 m), checked first with no network call; then one
  small Overpass `around:40` query (roads, parking areas, buildings; cached per ~11 m cell for 30 days in kv):
  driveway or private service way nearer than any street, a house with no street within 14 m, a private lot by a
  house. Saved as lot (inside/at `amenity=parking`), street (≤ 14 m of a street), or unknown when offline (a spot too
  many beats a lost car). Tunables: `packages/shared/src/parking/thresholds.ts`.
- Cleared when a new drive starts within 250 m of the car, after "Forget after" (12 / 24 / 72 h / next drive, default
  24 h), or on Forget. Settings → Driving: toggle (default on) + Forget after.
- Map: the user's own vehicle baked without the rider (`parkedSheet`), 44 dp, hidden while driving; tap → `/parked`
  sheet: time, street/lot, distance + walking minutes, Walk there (Mapbox Directions `walking`, counted in
  Diagnostics; straight line when offline/no token; ends within 20 m), note (80 chars), Forget, Share with {crew}.
- Private by default: spot, note and settings live only in the phone's kv table; nothing writes them to a crew doc,
  presence or the router. The only way out is the explicit per-spot "Share with {crew}" (one crew chat message with
  street, note and an openstreetmap.org link). A global auto-share was not added (would post into chat every drive).
  Replay test `tools/replay/test/parking.test.ts` checks every router kind a crewmate receives during a drive + park +
  walk away carries no spot, note or street until Share is tapped.
- Walk-away notice: silent "Parked on {street}" notification (app in background) the first time the user is 40 m from
  the car within 30 min of parking; opens the sheet.

## D66 — Ambient safety check-in after a long remote stop (2026-11-27)
- **What.** While travelling, a stop of 5 min or more (Settings → Driving: 5 / 10 / 15 min) somewhere remote makes the
  phone ask once: "Are you OK?" with one big "I'm OK" on an alerts-channel notification and a root-mounted in-app card.
  If it is still unanswered after `graceS` (3 min), each opted-in crewmate gets a sealed `check-in` message with the
  stop position and time. A late answer, or driving off, sends "all fine" to the same people. A crash-like spike (the
  trip pipeline's `crash` event) followed by no movement asks after 45 s and alerts 2 min later, whatever the place.
  The app never calls anyone.
- **Pure logic.** `packages/shared/src/safety/` holds `CheckInMonitor`, `assessStop`, `looksLikeJam` and the
  surroundings query/parser. Tunables are in `safety/thresholds.ts`. Tests are in `shared/test/checkIn.test.ts`, with
  fixtures in `test/fixtures/check-in-stops.json` (remote roadside, rest stop, home, traffic jam; public places only),
  and in `tools/replay/test/checkIn.test.ts`, which runs through the real trip pipeline, crash included. Times come
  from the fixes, so replay works.
- **Why the monitor owns its stop.** The trip detector ends a trip after 180 s stopped (walk-away after 60 s). By the
  5 min mark the trip is over, the profile is `still` and the IMU is off. So the monitor keeps its own stop: it opens
  when the car drops below 5.4 km/h within 10 min of doing 30 km/h or more, and closes on more than 40 m of movement,
  any move of 150 m or more, or walking.
- **What makes a stop ordinary.** Each of these cancels the ask:
  - inside a saved place (mine or the crew's), its radius + 100 m
  - within 1 km of a Home
  - within 300 m of the navigation destination
  - a learned D63 stop-delay cell (built on the phone from the last 20 trips)
  - a cell where I answered OK before (250 m)
  - a jam / closure / accident hazard within 500 m
  - a crawl or stop-and-go in the 3 min before the stop (a jam)
  - a cached fuel station or charger within 150 m (D64)
  - OSM within 150 m showing buildings, residential landuse, residential streets, driveways, rest or service areas,
    parking, fuel, food, toilets, shops, tourism, signals or stop signs

  Unknown surroundings (offline, which is likely at a remote spot) still ask. Asking is harmless, and nothing is ever
  sent without asking first.
- **Overpass load.** We don't add buildings to the 0.5° D61/D64 cells: one cell near Montréal holds hundreds of
  thousands of buildings. Instead, once a stop reaches 90 s, the app makes one `around:150` query with three
  `out count` blocks, a few hundred bytes. The result is cached per 250 m cell for 90 days and counted as `overpass` in
  Diagnostics. A crew makes a handful of these a month. The parking agent's D67 `parkingQuery` returns geometry for
  roads, lots and buildings, which costs more than a yes/no needs, so it was not reused. The two could share one
  lookup later.
- **Privacy and opt-in (D56 model).** `SharingPolicy.checkIn` and `UserOverride.checkIn` are new, and absent means off,
  so no existing crew is opted in silently. The switch is in:
  - the crew screen ("What this crew sees")
  - a friend's Custom sharing
  - the onboarding crew step (one switch, preset on, for the crew created or joined there)
  - the new-crew card on the crew screen
  - a confirmation step on `/join` after a link, QR or code join

  Opting in means consenting to send the exact stop position in an alert, even to a crew that normally sees a coarser
  location. A friend hidden by their own override gets no alert unless that override turns check-in on
  (`checkInAllowed`). Receiving is symmetric: alerts are shown only from crewmates I opted in to myself (crew policy, or
  my override for them).
- **Wire.** The new kind is `check-in` (fn `arrivals`, durable 6 h, acked), sealed per recipient through
  `companionSend`. There is no protocol bump and no capability bit, because older builds ignore unknown kinds. Payload
  is `{ v: 1, s: 'alert', lat, lng, acc, since, crash, t }` or `{ v: 1, s: 'ok', t }`. A crewmate's alert opens their
  screen, which shows a danger banner with "route there".

## D65 — Convoy mode (2026-11-27)
A convoy is a group drive (D46) whose members follow one leader. Pure logic in `shared/companions/convoy.ts`
(tunables `CONVOY` in `thresholds.ts`, Vitest `shared/test/convoy.test.ts`, 3-car replay `tools/replay/test/convoy.test.ts`).
- **Wire**: same `drive-along` kind and `v: 1`. `session.convoy = { on, leader, rev }`, carried by the invite and by a
  new `convoy` op. The host turns it on or off and picks any joined member as leader. The leader may only hand the lead
  on, and an older `rev` is ignored. A leaving leader hands the lead to the host, and a leaving host-leader to
  `successor` (no message, every peer agrees). There is no capability bit: builds without convoy ignore the op and the
  field and see a plain group drive (no strip order, no follow prompt). This also avoids a protocol bump colliding with
  other work.
- **Route**: the leader always shares its route (`route-share`, thinned ≤ 300 points) while in convoy, whatever the
  "Share my route" toggle says. A follower gets a one-tap "Follow X's route" pill (`noticePolicy('groupDrive')`,
  deferred before a turn). It fetches the rest of the leader's line from where I join it, as a via-constrained
  Directions query (`currentRouteQuery`). That is one call, skipped when the API budget is off, and it starts guidance on
  that route. A later reroute after leaving it goes back to the normal fastest route.
- **Gaps along the route, not straight line**: every phone projects all members onto the reference line, which is the
  leader's own nav route on the leader's phone and the shared line elsewhere. Projection is windowed (60 m back,
  ≥ 1.5 km plus speed ahead) so a route that doubles back never jumps legs. A leader reroute (new line starting
  ≤ 500 m from the leader's place) keeps the old line up to the leader and appends the new one, so the cars behind
  keep their place and history. Any other new line resets the tracks. Order = position along the line, and
  arrived members are at the front. Time gap = when the car ahead passed my current point, from its position history
  (30 min, ≤ 600 points), else distance over my speed (≥ 8 m/s). "N lights" = signals between us on my own nav route,
  which needs both cars on it; `NavRoute.signalsAlongM` is now parsed from Mapbox intersections. It is used only for
  1–3 signals within 2 km, else minutes (≥ 1 min), else metres.
- **Callouts**: spoken only about my neighbours (the car ahead of me, the car behind me) when the label bucket changes
  and holds for 10 s, at most every 90 s per car. In convoy the old straight-gap cues (D31) are off for members, and
  "different route" stays.
- **Regroup alert**: per member, the gap to the car ahead exceeds the distance limit (1 / 2 / 5 km, default 2) or the
  time limit (2 / 3 / 5 / 10 min, default 3). It must hold for 20 s, re-arms only under 60 % of both limits, and repeats
  at most every 5 min. Every phone runs the same watches, but only the leader and the car directly ahead of the gap
  are told, never the straggler. The alert is spoken as an alert, so it is heard in "alerts only" voice mode too (gap
  callouts are guidance). A spoken line is held while a turn is < 250 m away, then
  dropped after 60 s. It also shows a non-interactive banner row in the companion strip for 8 s, hidden near a turn.
- **UI**: no new screen. The companion strip (D31 safe positions) lists members in line order with an order badge
  (leader tinted) and the signed gap. The map name chip shows "2. Sam" from a low-rate `convoyOrder` store, so the map
  tree only re-renders on an order change (D28). The drive-together screen has a Convoy toggle (default on when sending),
  plus a leader list with "Make leader", regroup limits, "Mute convoy alerts" and "Follow". The arrival summary adds
  "+N min" after the first arrival.
- **Per-crew mute**: device-local `convoyPrefs` (kv), with no change to the settings store. The crew is the session's
  crew, else the first crew (by id) that holds every joined member. Mute silences callouts and regroup alerts, not the
  strip.
- **Not done**: auto-forming a convoy for crewmates who navigate to the same place outside a group drive. Destinations
  are not on the wire, and broadcasting them would be a privacy change.

## D68 — Trip memories (2026-11-27)
- **Where**: no new tab and nothing on the map. Entry is a sparkle button in the Drives header (`/memories`), plus at
  most one dismissible recap card at the app root after a group outing (never while driving/guiding, never over the
  catch-up fanfare, shown once per memory, `mem-recap-card`).
- **Grouping** (`packages/shared/src/memories`, tunables in `config.ts`): my drives chain into one outing when the stop
  between them is ≤ 3 h. A crewmate was there when their fixes (as received on my phone, exact precision only) stay
  within 450 m of my interpolated position for ≥ 8 min or ≥ 35 % of the outing; fix gaps > 4 min add no together-time.
  Drive-along / group-drive membership counts too. A solo outing is kept only when notable (≥ 150 km, ≥ 3 h driving,
  longest in 30 days, or a stop in a new city). Outing id `o-<first trip id>`.
- **Recap**: compressed playback (moving time to ~24 s, each stop one 1.2 s beat) with every member's 3D ride on the
  map, trails, emote bubbles as the clock passes them; highlights scored and capped at 4 (distance, time out, top speed
  incl. a crewmate's when shared, farthest, stops, crew, hype champ, photos, night owl / early bird); who joined and
  when; named stops (my places, else the visit city: no geocoding calls); timeline; reactions (6 emoji, toggle).
- **Sharing** (`packages/p2p/src/memories.ts`, protocol 10, cap `memories`): kinds `memory`, `memory-photo`,
  `memory-blob`, `memory-react`, all box-sealed to each outing member (not the whole crew) and built per recipient from
  my effective policy (crew + override): the post needs trip history; my route only with exact location; top speed
  only with stats and speed; photos and reactions follow the emotes switch. Receivers match a post to their own
  memory by alias or window overlap (≥ 30 % of the shorter), else keep a remote-only memory.
- **Photos**: gallery (system picker) or camera, re-encoded on device by a new `platform.photos` service (Kotlin
  `PhotoTools`: ≤ 1600 px, ≤ 220 KB JPEG, EXIF rotation applied, metadata incl. GPS dropped), sent as hash-verified
  16 KB chunks (quips' chunker), max 6 per member per memory, own LRU store (120 MB, `memories.blobs`). Each photo
  carries an expiry: 90 days after the outing (max 365), then deleted on every phone unless that phone keeps the memory.
  The sender can withdraw a photo. Photos never leave the crew: the share card excludes them.
- **Share card**: 1080×1350 PNG drawn with react-native-svg (already a dependency, MIT) and its `toDataURL`, saved to
  Pictures/CrewMap and handed to the share sheet. It carries only my route and numbers, crewmates as initials, top
  emotes. No new libraries. A video clip was not built: it would need an encoder library.
- **Storage / retention**: `mem_tracks` and `mem_events` are raw and follow the retention purge; `memories` rows are
  self-contained. After retention an unkept memory loses its tracks and routes but keeps its digest, so the season /
  year review still counts it. "Keep" (heart) exempts it from both retention stripping and photo expiry.
- **Season review**: computed on the phone from its own memories only (outings, km, hours, photos, emotes, week streak,
  busiest month, most rides with, top places, longest), offered for the current and last season and this / last year
  when ≥ 2 outings.
