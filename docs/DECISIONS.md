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
