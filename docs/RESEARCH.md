# CrewMap — Phase 0 research

Verified 2026-11-23 against official docs, package registries and live endpoints. Each subsystem lists the
options compared, what we learned from proven designs, and the choice. Licence notes: we learn from designs;
we copy no code whose licence is incompatible (GPL apps such as OsmAnd/Organic Maps/Briar are reference only).

## Stack versions (npm `latest`, 2026-11-23)

| Package | Version | Notes |
|---|---|---|
| expo | 58.0.x | targets react-native 0.88.1, New Architecture is mandatory since SDK 55 |
| react-native | 0.88.1 | Hermes |
| @rnmapbox/maps | 10.3.19 | Expo config plugin; native Mapbox Maps SDK v11 |
| react-native-webrtc | 155.0.1 | + @config-plugins/react-native-webrtc |
| react-native-libsodium | 1.7.0 | Expo plugin |
| yjs / nostr-tools | 13.6.33 / 2.26.1 | pure JS |
| Node.js | 24.22.3 LTS "Krypton" | portable copy in `.tools/node` |
| pnpm | 12.x | via corepack |
| JDK | Temurin 17.0.21 | portable copy in `.tools/jdk17`; Android Studio's bundled JBR is 25, too new for the RN Gradle toolchain |

## Background location (OwnTracks, Traccar client, Hauk, expo-location)
- OwnTracks (EPL/MIT-ish) and Traccar Client (Apache-2.0) both use a location-type **foreground service** with a
  persistent notification and adaptive intervals; both move between "significant change" and "move" modes. Hauk
  (Apache-2.0) shows short-lived share links with E2E crypto, confirming the "live location = ephemeral messages" model.
- `expo-location` + `expo-task-manager` give background updates with an Android foreground service on both platforms.
- Learned: don't sample at a fixed rate; switch intervals on activity (still → 5 min / walking → 30 s / driving →
  1 s with distance filter 5 m). Batch points while offline and flush on reconnect (Traccar's queue).
- **Choice:** expo-location (foreground service config) + our own Expo module for Activity Recognition.

## Trip detection & risky events
- Life360 / Zendrive-style detection: activity transition (IN_VEHICLE ENTER) + speed > 15 km/h sustained;
  stop after STILL/ON_FOOT + speed < 5 km/h for 3 min. Traccar's server-side trip logic (distance + idle time)
  confirms the hysteresis approach.
- Google Play services Activity Recognition **Transition API** is Android-only (iOS equivalent: CMMotionActivityManager).
- Risky events (literature + OpenTelematics thresholds): hard brake ≤ −3.4 m/s², rapid accel ≥ 3.0 m/s², harsh
  cornering lateral ≥ 3.0 m/s² (from GPS heading rate × speed, cross-checked with gyroscope), crash ≥ 4 g spike.
  All in `packages/shared/src/driving/thresholds.ts` with tests.

## Turn-by-turn navigation (Organic Maps, OsmAnd, Valhalla, OSRM, Mapbox)
- Organic Maps/OsmAnd (Apache-2.0 / GPL): route-progress state machine = snap to route polyline, distance-along,
  off-route if > 40 m for > 5 s (with heading check) → reroute with backoff. We reimplement this pattern in TS.
- Mapbox Directions `driving-traffic` returns `banner_instructions`, `voice_instructions`, lanes (`components` of type
  `lane`), and `annotations=maxspeed,congestion,duration,distance,speed`, plus `incidents`. That's everything F11 needs,
  so we don't use the Navigation SDK (its free tier is only 100 MAU / 1,000 trips, and it renders its own UI).
- Fallback if Mapbox stops fitting: Valhalla (MIT) self-host has the same banner/voice concepts. Not needed now.

## Map rendering, 3D buildings, ramps (MapLibre, Mapbox Standard)
- Mapbox Standard style (v11) has 3D buildings, terrain, day/dusk/dawn/night `lightPreset`, and draws bridges/tunnels
  with elevation-like casing. Ramps (`highway=*_link`) are in the `road` source layer with `class` + `structure`
  (`bridge`/`tunnel`) + `layer` fields, so we can add our own raised/shadowed line layers and chevrons.
- MapLibre + OpenFreeMap is the documented fallback (no 3D-road styling built in; same custom-layer approach).

## Avatars (Kenney, Quaternius, Blender)
- Ready Player Me shut down. Kenney (CC0) and Quaternius (CC0) provide low-poly bases; we generate our own
  procedural parts in Blender so licensing stays simple (CC0 bases allowed, listed in `ASSETS_LICENSES.md`).
- Snapchat-Map-style presence uses pre-rendered sprites (Bitmoji are 2D renders). Multi-angle sprites keep map fps high.

## Real-time presence & P2P transport

| Option | RN/Expo support | Android background | Battery | Verdict |
|---|---|---|---|---|
| Hyperswarm/HyperDHT via Bare (`react-native-bare-kit` 0.6.x) | Separate Bare runtime + worklet bundle | Pear docs: the worklet **must stop all active I/O when backgrounded or the OS kills it** | DHT keep-alive traffic | Rejected for the default path |
| WebRTC data channels (`react-native-webrtc` 124.x + `@config-plugins/react-native-webrtc`) | Expo plugin, both platforms | Runs inside our location foreground service | Idle channel ≈ free; ICE keepalives | **Chosen for direct** |
| Nostr relays (NIP-01, NIP-40, ephemeral kinds 20000–29999) | Pure JS (`nostr-tools`) over WebSocket | One WebSocket per relay inside the foreground service | Low | **Chosen for store-and-forward + signalling** |
| Berty / Briar / Bitchat | Go/Java/Swift apps | — | — | Reference only (Briar's BLE/Tor and Bitchat's BLE mesh inform the deferred BLE contract) |

- NIP-11 check (2026-11-23), NIP-40 supported by: `relay.damus.io`, `nos.lol`, `relay.primal.net`, `nostr.mom`,
  `offchain.pub`. Not: `relay.snort.social`. `relay.nostr.band` didn't answer.
- Mobile carrier CGNAT often blocks direct WebRTC without TURN. TURN costs money, so we don't run one; Nostr carries
  the message instead. Direct is an optimisation, never a requirement.
- No public STUN costs: `stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`.

## CRDT (Automerge, Yjs)
- Automerge's core is Rust→WASM, and Hermes exposes no `WebAssembly` global; only an experimental JSI port exists.
- Yjs is pure JS (needs `crypto.getRandomValues`, provided by `react-native-get-random-values`). **Chosen: Yjs.**

## Crypto (libsodium, MLS)
- `react-native-libsodium` (Serenity Kit) mirrors `libsodium-wrappers` with an Expo plugin; JSI on native, wasm/JS on web
  (used for Node tests via `libsodium-wrappers-sumo`).
- MLS: `ts-mls` (RFC 9420) is not audited and depends on WebCrypto/HPKE that Hermes lacks. For ≤ 20 members a
  sender-keys/epoch-key scheme on libsodium primitives is simpler and auditable (see DECISIONS D6).

## Wake-ups (UnifiedPush, ntfy)
- UnifiedPush needs a distributor app on the phone (ntfy is the common one). ntfy server defaults (docs.ntfy.sh/config): request bucket of 60 per visitor, refilled 1 per 5 s; 30 subscriptions
  per visitor. With UnifiedPush subscriber-based limiting, `up*` topics count against the subscriber, and publishing to a topic
  with no subscriber for 4 days returns 410. The ntfy.sh public free-tier daily cap isn't published in the docs, so we
  measure it in the benchmark. Content-free pings at ≤ 1/min per device fit well inside the bucket.
- While sharing, the foreground service keeps our Nostr subscriptions open, so most wake-ups aren't needed at all.

## Hazard data
### Waze Live Map
- Endpoint used by the live map: `GET https://www.waze.com/live-map/api/georss?top=&bottom=&left=&right=&env=na&types=alerts,traffic`
  (`env=na` for North America). Response: `{ alerts: [{ uuid, type, subtype, location:{x,y}, street, city, pubMillis,
  reliability, confidence, nThumbsUp, reportRating, magvar }], jams: [...] }`.
  Used by e.g. `guberm/waze-alerts-monitor`, `mccre110/waze-pinger`, `ArgeliusLabs/waze_osint`.
- **Status:** two independent 2025–2026 reports say the endpoint is now gated by Google's edge: automated requests get
  **HTTP 403** and need a reCAPTCHA-earned session cookie (`KaraZajac/OVERWATCH` README; `MatteoFX1/kite-maps` PR #13).
  We don't build captcha or block evasion (prompt §F4.2), so the adapter runs honest requests, health-checks them,
  and degrades to other sources. A live probe is pending your permission (see the checklist).
- Paid hosted alternatives: OpenWeb Ninja `waze/alerts-and-jams` (~US$0.005/request, 100 free/month), Apify Waze actors.
### Google Maps police reports (time-boxed check, ≤ 30 min)
- Google Maps Platform (Routes, Roads, Places, Maps JS) exposes **no** user incident/police reports; Waze for Cities
  is partner-only and Google Maps alerts flow *into* Waze (Waze forum pilot "Supplementing the Waze Map with Google Maps
  Alerts"), not out. No legitimate public route exists → no adapter; Waze covers it.
### Québec (MTMD WFS, CC-BY 4.0), verified live 2026-11-23
- Base: `https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&srsname=EPSG:4326&outputformat=geojson&typename=…`
- Layers: `ms:chantiers_mtmdet` (road works, LineString), `ms:evenements` (closures/events incl. `cause`), `ms:radars_photos`
  (fixed/mobile photo radar points), `ms:conditions_routieres`. Supports `bbox=` filtering.
### Mapbox incidents
- Directions `driving-traffic` returns `incidents[]` (type, description, congestion, closed, geometry_index range).

## Mapbox free tier (mapbox.com/pricing, 2026-11-23)
| API | Free / month | After |
|---|---|---|
| Maps SDK for Mobile | 25,000 MAU | $4 / 1k MAU |
| Directions (incl. driving-traffic) | 100,000 req | $2 / 1k |
| Matrix | 100,000 elements | $2 / 1k |
| Search Box | 25,000 requests **or** 2,500 sessions | $1.70 / 1k req; $11.50 / 1k sessions |
| Map Matching | 100,000 req | $2 / 1k |
A 20-person group uses well under 10% of each, if search is billed per request (DECISIONS D2).

## Patterns taken from inspiration apps (F9)
- **Snapchat Map:** sprite avatars, bouncy tap-to-open sheets, live pose by activity, "action" cluster bubbles.
- **Life360:** circles, places with radius, arrival/leave alerts, driver reports, per-trip score, crash alert.
- **Google Maps:** search-first top bar, route alternatives as chips, lane guidance strip, traffic colouring, "then" turn.
- **Apple Maps:** calm high-contrast driving mode, 3D landmark clarity, large next-maneuver banner, quiet colour palette.

### Incident feeds re-verified (2026-11-24)
- **MTMD WFS** `https://ws.mapserver.transports.gouv.qc.ca/swtq` (`ms:chantiers_mtmdet`, `ms:evenements`,
  `ms:radars_photos`; WFS 2.0, `outputformat=geojson`, lat,lon BBOX) — unchanged URLs and fields. This is the same
  endpoint Données Québec lists as the "Travaux routiers" GeoJSON/CSV/WFS resources (CC-BY 4.0, frequency
  "continuous"; metadata touched 2026-11-24 13:18 UTC; chantier `miseAJour` stamps within hours). No separate public
  Québec 511 "entraves" API: `ms:evenements` is that feed (14 events province-wide today, none near Val-Clair).
- **Near Val-Clair today** (bbox 45.45–45.80 N, 74.55–73.80 W): 9 chantiers, 5 active at 10:00 — R-148 Pont-Ouest
  → A-50 O (until 11-27), A-50 between R-344 Grenville and R-148 (until 11-27), A-640 Rosemère, A-15/A-640 Boisbriand,
  Rigaud; 4 more are night-only windows (Boisbriand A-640 exit 20, pont Vachon) shown only once started. 4 photo radars
  (incl. A-50 Val-Clair–R-148). Porte-Sud: no record today.
- Drift fixed: DST approximated by month (wrong 2nd Sun Mar–31 Mar); "Fermeture de 1 voie sur 2" typed as a full closure;
  works shown up to 24 h before start (many are one-night windows); records kept 6 h / 7 d / until end on peers after
  vanishing from the feed → now `expiresAt = min(end, now + 2 h)`, re-asserted every 15 min; `endsAt` kept for detail.
- **Ville de Montréal "Entraves et travaux en cours"** (vmtl-info-travaux, CC-BY 4.0, daily ~07:00 UTC): CKAN
  `https://donnees.montreal.ca/api/3/action/datastore_search` resources `cc41b532-…` (permits) + `a2bc8014-…` (street
  impacts). CSV downloads return 403 without a browser UA; `datastore_search_sql` is disabled; the real-time CIFS API
  (`api.montreal.ca/.../export-cifs`) returns 404. Today: 1 814 permits / 1 891 impacts → 573 active with traffic impact
  (156 street closed, 417 lane). ~200 kB gzipped; refreshed every 6 h, schedules re-evaluated locally.
- **Mapbox**: `legs[].incidents` (driving-traffic) → hazards with along-route line; `incidentsAlong()` counts per route.
  Shared `RouteIncident` lacks `creation_time`/`end_time`, so age = first seen on device.

## On-device TTS for navigation (2026-11-24)
| Option | en / fr / ru | Start latency | APK cost | Licence | Notes |
|---|---|---|---|---|---|
| Android system TTS (Google Speech Services) | yes (en-CA/US, fr-CA/FR, ru-RU offline packs) | ~50–150 ms after bind (estimate) | 0 | system | per-utterance `Voice`, QUEUE_ADD, nav audio attributes; voice packs may need a one-time download |
| Supertonic 3 (Supertone, ONNX) | 31 languages incl. fr, ru | fast (vendor claim) | ~250–400 MB of models (estimate) | code MIT, weights OpenRAIL-M | company reported (unconfirmed) dissolving 2026-07, repo to be archived |
| Piper / sherpa-onnx VITS | yes (e.g. `fr_FR-siwis`, `ru_RU-irina`) | 100–300 ms cold per model (estimate) | ~60–75 MB per voice (estimate) | MIT / Apache-2.0 (voice data varies) | no fr-CA voices; one model per language → reload on switch |
| Kokoro (82M) | en, fr; no ru (unverified) | GPU-friendly, slow on mid phones | ~90–330 MB | Apache-2.0 | lacks Russian |
Mapbox Directions `language` lists en, fr and ru (to verify on a live ru request) for `voice_instructions` and `banner_instructions`.
Sources: huggingface.co/Vocabook/supertonic-3, github.com/supertone-inc/supertonic, marktechpost.com (2026-05-15 Supertonic v3).

## Performance research (2026-11-24)
Verified (fetched/searched 2026-11-24):
- Inline requires: Expo does NOT inline by default; enable `inlineRequires: true` in Metro `getTransformOptions`.
  Hermes release builds load precompiled bytecode on demand; RAM bundles are unsupported with Hermes. No official
  numbers: measure. https://reactnative.dev/docs/optimizing-javascript-loading
- React Compiler: `experiments.reactCompiler: true`; Babel is auto-configured from SDK 54 (lint rules in
  eslint-config-expo from SDK 55). https://docs.expo.dev/guides/react-compiler/
- Mapbox Android v11 view annotations: best kept "generally below 100" per map (device-dependent); for large point
  sets use symbol layers. https://docs.mapbox.com/android/maps/guides/add-your-data/view-annotations/
- FlashList: Shopify measured up to 5× UI-thread FPS and 10× JS-thread FPS vs FlatList (Moto G10, 60 Hz); worth it
  only for long lists. https://shopify.github.io/flash-list ·
  https://shopify.engineering/instant-performance-upgrade-flatlist-flashlist
Background (not re-verified):
- Callstack, Ultimate Guide to RN Optimization (callstack.com/ebooks): measure first, atomic selectors, worklets.
- Zustand: selectors that return new objects need `useShallow`. Telemetry off: `Mapbox.setTelemetryEnabled`
  (present in @rnmapbox/maps 10.3 RNMBXModule).
Measured off-device (tsx bench, 75 km / 7.5k-pt route, per 250 ms fix): RouteProgress.update 14 µs,
MotionSmoother on-track 572 µs → 16 µs after windowed matching, 30 friend smoothers @30 fps 70 µs.

## Battery research (2026-11-24)
Not re-fetched in this session: figures marked *unverified* are recalled from secondary sources and are planning
inputs, not benchmarks.
- **Life360**: no official per-day drain figure published. Its help centre blames drain on high-accuracy
  settings and Driving Detection, and recommends keeping Background App Refresh / unrestricted battery
  (https://support.life360.com). Architecture, from its Android behaviour and engineering posts: activity recognition +
  geofences around the current place + significant-location-change on iOS, a location foreground service on Android,
  and a server that pulls a fix on demand when a member opens the map ("ping"). Users commonly report 5–15 %/day
  (*unverified*, forum reports).
- **Google Maps navigation**: no official figure. Third-party tests put screen-on turn-by-turn at roughly 10–20 %/h
  on phones of the OnePlus 8 class (*unverified*). Most of that is the screen and GPU, then GNSS at 1 Hz and data.
- **Fused Location Provider** (https://developer.android.com/develop/sensors-and-location/location/battery,
  https://developer.android.com/reference/com/google/android/gms/location/Priority):
  - Cost from lowest to highest: PASSIVE (free, piggybacks on other apps), LOW_POWER (~city-block accuracy,
    Wi-Fi/cell, no GNSS), BALANCED (~100 m, mostly Wi-Fi/cell, GNSS rarely), HIGH_ACCURACY (GNSS).
  - `setMaxUpdateDelayMillis` lets the chip batch fixes and wake the AP once per batch.
  - expo-location sets maxUpdateDelay = interval, so real batching would need a native patch. Its
    `deferredUpdatesInterval` only batches JS delivery.
- **Activity Recognition Transition API** (https://developer.android.com/develop/sensors-and-location/location/transitions):
  runs on the low-power sensor hub, delivers ENTER/EXIT only, and is the recommended trigger for switching tiers.
  Periodic `requestActivityUpdates` has a cost that scales with the interval.
- **Geofencing** (https://developer.android.com/develop/sensors-and-location/location/geofencing): ≥ 100–150 m radius;
  a responsiveness of minutes saves power. Fences survive app death (re-register after boot).
- **Doze / App Standby / WorkManager** (https://developer.android.com/training/monitoring-device-state/doze-standby,
  https://developer.android.com/topic/libraries/architecture/workmanager): a foreground service exempts the process
  from Doze network restrictions, which is why idle sockets keep costing. PeriodicWork runs at ≥ 15 min, inside
  maintenance windows. FGS types (`location`, `dataSync`) are mandatory on Android 14+
  (https://developer.android.com/develop/background-work/services/fgs/service-types).
- **GNSS duty cycling**: the chip's duty-cycling and batching modes only take effect when nothing asks for 1 Hz high
  accuracy. One stray HIGH_ACCURACY 1 s request (e.g. a map SDK's location provider) keeps GNSS on continuously.
- **Radio tail energy** (Huang et al., MobiSys 2012, https://doi.org/10.1145/2307636.2307658): after any transfer,
  LTE stays in RRC_CONNECTED for ~10 s plus DRX tail, ≈ 1–2 J per wake-up whatever the payload. A 30 s WebSocket ping
  therefore costs about as much as a chatty socket. Coalesce sends and stretch keep-alives.
- **Nostr relays**: one socket per relay shared by all subscriptions (NIP-01, https://github.com/nostr-protocol/nips/blob/master/01.md).
  nostr-tools pings every 29 s by default. Strategies: one pool, few relays (2–3), longer pings, `since`-based replay
  on reconnect instead of always-on sockets, and push wake-ups for store-and-forward.
- **WebRTC idle**: an open PeerConnection sends ICE consent-freshness STUN checks about every 5 s (RFC 7675,
  https://www.rfc-editor.org/rfc/rfc7675). That is a radio wake every few seconds, so idle links should be closed.

## Hazard sources, re-check 2026-11-24
- MTMD WFS (`ws.mapserver.transports.gouv.qc.ca/swtq`, CC-BY 4.0) GetCapabilities lists `ms:evenements`,
  `ms:evenements_inondation`, `ms:chantiers_mtmdet`, `ms:radars_photos`, `ms:conditions_routieres` (surface code
  `CodeEtatChaussee`, visibility `CodeVisibilite`, `EnVigueurDepuis`), `ms:infos_cameras`, `ms:stations_meteoroutieres`.
  All return GeoJSON with `outputformat=geojson`; the first five are now used (D44).
- Waze Live Map: a website's internal endpoint behind bot protection; not used (D40). Waze for Cities / partner
  feeds require a public-sector partnership, not available to a private app.
- Google Maps / Waze on-device notifications: ETA and next maneuver only; no police or hazard content (D25).
- Mapbox Directions: `annotations` accepts `congestion` and `congestion_numeric` together, plus `speed` and `duration`
  (per segment). 100 000 requests / month free, then billed per 1 000 (see Mapbox pricing page).
- NIP-13 proof of work (https://github.com/nostr-protocol/nips/blob/master/13.md) and NIP-40 expiration are what the
  anonymous network uses for abuse resistance and expiry.
