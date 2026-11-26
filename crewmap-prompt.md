# Build "CrewMap": a private friends' location, driving-stats & navigation app

You are Claude Code. Build a complete, production-quality mobile app (not an MVP) from this prompt with as little back-and-forth with me as possible. Create a **private** GitHub repo under my account (`gh repo create crewmap --private`) and push to it as you go.

This is a clean-room build *inspired by* Life360, Snapchat Map, Google Maps and Apple Maps. Don't decompile those apps or copy their code or assets. The one deliberate exception is the Waze live-alert data adapter in F4, which reads the same public alert data shown on the Waze Live Map website.

---

## 0. Config (defaults; change here if needed)

| Key | Value |
|---|---|
| App name | CrewMap |
| Repo | `crewmap`, private, under my GitHub user (use `gh` auth) |
| Platforms | **Android first:** fully built, tested and installable on my Android phone. **iOS-ready:** one shared codebase built so iOS can be added later with minimal work (Section 2B), but no iOS builds yet |
| Home region | Val-Clair / Highlands / Montréal area, Québec, Canada |
| Units | Metric (km, km/h), 24h time; UI in English with French strings ready (i18n) |
| Users | One small invite-only friend group (~5–20 people) |
| Cost | Must run on free tiers for this group size. Flag anything that could cost money before using it |
| Architecture | Local-first, end-to-end encrypted, **P2P-first**: phones talk directly or through free public relays that only see ciphertext; the home PC is a measured fallback only (Section 2A) |
| Workspace | Windows PC, repo cloned to `D:\Tools\CrewMap`. All project files, SDK caches you control, build output and tools config live under that folder |
| Test phone | Android phone on USB with USB debugging on (`adb devices` shows it). Model: ____ (use for OEM battery-optimisation guidance) |

**Scope already reviewed with me (don't reopen it):** P2P-first transport with the home PC as a measured fallback; sprite avatars on the map; Health Connect/HealthKit deferred. The P2P benchmark and multi-peer simulator are back in scope, because they decide when the PC is needed. Everything else in Section 3 stays required.

## 1. Working rules (read first, follow all session)

1. **One upfront human step.** Before writing app code, give me ONE checklist of everything only I can provide (map/routing API token, Android signing key, how to enable USB debugging / install the test APK, the central PC's one-time setup only for functions that end up there, and every system-wide install you need, e.g. Docker Desktop + WSL2, which needs a reboot). No Apple account is needed until iOS is added. Put placeholders in `.env.example`, load real values from `.env` (git-ignored, never committed). After that checklist, don't stop to ask me things: make the best decision, record it in `docs/DECISIONS.md`, and continue.
2. **Research before building (Phase 0).** For each hard subsystem (background location, trip detection, risky-event detection, turn-by-turn navigation, 3D map rendering, avatars, real-time presence, peer-to-peer sync and transport), find actively maintained open-source projects on GitHub with clear licenses. Examples: OwnTracks, Traccar, Hauk, Organic Maps, OsmAnd, Valhalla/OSRM, MapLibre, Kenney/Quaternius CC0 assets. For P2P: Holepunch (Hyperswarm/HyperDHT, Bare runtime for mobile), WebRTC, Nostr (NIP-40, ephemeral events), Berty, Briar, Bitchat, Automerge, Yjs, UnifiedPush/ntfy. Compare their approaches, dependencies and known issues, learn from the proven designs, and don't copy incompatible or unknown-licence code. Write the findings and final stack to `docs/RESEARCH.md`.
3. **Verify the stack; don't trust it blindly.** The stack below is my recommended default. Confirm current versions, free-tier limits and capabilities from official docs before committing. If something doesn't hold up, swap it and record why.
4. **Spike the risky parts first** (Section 4) before building everything else on top of them.
5. **No stubs, placeholder screens, "TODO: implement" or fake data in the shipped app.** Seed/demo data is allowed only behind a dev flag.
6. **Survive restarts.** Keep `CLAUDE.md` (architecture, commands, conventions) and `docs/PROGRESS.md` (phase checklist, what's done, what's next) current. Commit at the end of each phase with clear messages.
7. **Tight output.** When running builds, tests and linters, report only failures plus a one-line summary.
8. **Subagents only for simple leaf work.** Once `CLAUDE.md` and the monorepo exist, you may hand very simple, isolated, test-backed tasks (e.g. an i18n string file, a pure function with fixtures, a config plugin) to subagents running Opus at low effort. Architecture, crypto, transport, navigation and anything cross-cutting stay in this session.
9. Elevate UX, developer experience and agent experience together without breaking existing features. Keep UI copy minimal: no taglines, helper text or secondary labels. If a screen needs them to make sense, fix the layout instead.

## 2. Recommended default stack (verify in Phase 0)

- **App:** TypeScript, React Native + Expo (dev client / prebuild; local Gradle builds first, EAS Build optional), Expo Router, Reanimated, Zustand or similar, TanStack Query. Custom native modules (Expo Modules API) wherever a JS library is missing or paid.
- **Map + navigation:** Mapbox Maps SDK v11 via `@rnmapbox/maps` (3D buildings, 3D model layers, live traffic layer), plus Mapbox Directions API with the `driving-traffic` profile (traffic-aware routing, `banner_instructions`, `voice_instructions`, `maxspeed` + `congestion` annotations, incidents). **Build the guidance UI ourselves** on top of route data (needed for feature 11); add rerouting, lane guidance and spoken instructions (TTS). Search/geocoding via Mapbox Search. Fallback if Mapbox limits/costs don't fit: MapLibre + OpenFreeMap/Protomaps tiles + Valhalla.
- **Networking & data:** peer-to-peer and local-first, E2E-encrypted, no backend of ours (Section 2A). Local SQLite (`expo-sqlite`/`op-sqlite`), CRDT sync, libsodium (`react-native-libsodium`) for all crypto.
- **Notifications:** local notifications for everything computed on-device. Remote wake-ups only as described in Section 2A.
- **Location/motion:** `expo-location` + `expo-task-manager` background updates, plus a custom native module for Android Activity Recognition / iOS CoreMotion activity (driving, walking, still). Avoid paid licences such as the commercial background-geolocation SDK unless I approve.
- **3D assets:** Blender run headless (`blender -b -P script.py`) to procedurally build and export low-poly glTF/GLB avatars, clothing and cars. Ready Player Me is no longer available, so avatars are our own system. CC0 bases (Kenney, Quaternius) are allowed with a licence check.
- **Tooling:** pnpm monorepo (`apps/mobile`, `packages/p2p`, `packages/hazards`, `packages/shared`, `relay/` for the optional central-PC fallback, `tools/blender`, `tools/replay`), ESLint, Prettier, Vitest/Jest, Maestro for end-to-end UI flows, and GitHub Actions CI (lint, typecheck, tests, P2P protocol + encryption tests).

## 2A. Architecture: P2P-first, local-first, E2E-encrypted

The goal is **no server of ours**. Each phone keeps its own data; friends' phones exchange end-to-end encrypted messages directly, or through free public infrastructure that only ever sees ciphertext. My home PC is a **measured fallback only** (and possibly the iOS push gateway later). Third-party services that can't be P2P stay as they are: Mapbox (tiles, routing, traffic), the hazard sources, and the OS push services.

- **Identity & circles:** each device generates a keypair on first launch, stored in Android Keystore / iOS Secure Enclave. Joining a circle means scanning a QR code in person or opening a one-time invite link. Distribute circle keys, and rotate them when someone is removed (evaluate MLS vs a sender-keys scheme). Use vetted libraries; never hand-rolled crypto.
- **Data:** local SQLite on every phone.
  - Durable shared state (profiles, avatar configs, shared places, friend reports, allowed stats summaries, arrival subscriptions) syncs as CRDT documents (Automerge or Yjs), encrypted before it leaves the phone.
  - Live location and emotes are short-lived encrypted messages, not stored history.
  - Raw trip and location history stays on its owner's phone. Friends receive only the summaries the owner allows. Optional encrypted backup goes to the owner's own Google Drive / iCloud.
- **Transports**, picked automatically per message, best first:
  1. **Direct over the internet:** Hyperswarm/HyperDHT (Bare runtime, e.g. `react-native-bare-kit`) or WebRTC data channels with public STUN. Pick one in Phase 0 by Android background behaviour, battery cost and React Native support.
  2. **Same Wi-Fi:** local discovery (mDNS or the chosen stack's LAN discovery) only if it comes nearly free with option 1.
  3. **Store-and-forward for offline/backgrounded peers:** several public Nostr relays for redundancy, carrying ephemeral or short-expiry (NIP-40) events signed by rotating per-circle pseudonymous keys, so relays see only ciphertext and minimal metadata. Phones catch up on reconnect via CRDT sync.
  - **Bluetooth LE:** deferred; interface contract only.
- **Waking a backgrounded phone:**
  - **Android:** while sharing, the location foreground service keeps the P2P/Nostr subscription open. For wake-ups otherwise, use UnifiedPush with the public ntfy.sh server (content-free "sync now" pings, random topic per device). No PC needed. Verify ntfy.sh and relay rate limits in Phase 0.
  - **iOS (build later, design now):** APNs needs a server holding the push key. Plan a tiny gateway that forwards only content-free pings, as a free serverless function (e.g. Cloudflare Workers) or on the PC. Define its interface in `packages/p2p` now; build it with the iOS port.
- **Shared chores:**
  - Québec government feeds: fetched by the elected "chore peer" (a phone that is charging and on Wi-Fi) and shared with the circle.
  - Waze: each phone fetches for its own route/viewport and shares the normalised alerts encrypted with the circle.
  - ETA/distance to friends: computed on each phone from decrypted friend positions. Stats rollups: on the owner's phone.
- **Pluggable transport:** `packages/p2p` exposes one interface (send, subscribe, sync, wake). Each function (presence, emotes, arrivals, sync, chores, wake) can be switched by config between P2P and the optional `relay/`, with no app changes.

**Central PC fallback (optional, build last).** `relay/` (Docker Compose, one command) is a blind store-and-forward relay that holds no circle keys and only sees ciphertext. It's reached through Tailscale Funnel or a Cloudflare Tunnel, never opened router ports. A function moves to it only when the benchmark says so; mixing per function is fine.

**Decide by measurement, not by guess:**
- **Benchmark:** a "Transport benchmark" mode in developer settings, plus a multi-peer simulator in `tools/replay/` (N virtual phones, packet loss, offline/background periods).
- **Runs:** a 1-hour drive replay and 8 hours idle, P2P vs relay. Run everything you can in emulators/CI. Battery needs my real phone, so the app lets me run the benchmark once (e.g. overnight) and produces a report plus a suggested config switch.
- **Measure:** extra battery drain vs. the app not running; p50/p95 staleness of a driving friend's location as seen by others; delivery rate and latency of emotes and arrival alerts to a backgrounded phone; CPU, memory and map fps.
- **Switch rule:** move a function to the PC only if P2P costs more than 25% extra battery, p95 staleness exceeds 60 s while driving, emote/arrival delivery falls below 98% within 30 s, or fps visibly drops.
- **Defaults until real numbers exist:** P2P for everything. Record results and choices in `docs/P2P-BENCHMARK.md`.

## 2B. Android first, iOS-ready

Build and verify everything on Android now. Structure the code so iOS later is mostly "fill in the native adapters and build", not a rewrite, and spend no effort on iOS beyond that.

- **One shared codebase.** All UI, state, map, navigation, stats, scoring, P2P protocol, crypto, CRDTs and hazard adapters are platform-neutral TypeScript, shared 100% between platforms.
- **Platform code only behind interfaces** in `packages/platform/`:
  - interfaces: location + background service, motion/activity recognition, geofencing, health data, secure key storage, Bluetooth LE, background networking/wake-ups, audio ducking, haptics;
  - each has an `android/` implementation now, except **health data** and **Bluetooth LE**, which are deferred and have contracts only;
  - each has an `ios/` folder holding only the interface contract, the native API to use (CoreLocation, CoreMotion, HealthKit, Secure Enclave, CoreBluetooth, APNs, AVAudioSession), and its known limits.
- **Enforce the boundary:** an ESLint `no-restricted-imports` rule blocks platform-specific packages outside `packages/platform/`, so Android-only code can't leak into shared code.
- **Library choice:** prefer libraries that support both Android and iOS (check this in Phase 0). If only an Android option exists, wrap it behind the interface and record the iOS equivalent.
- **Cheap prep now:** fill in the iOS side of `app.config.ts` (bundle ID, Info.plist permission strings, background modes) via Expo config plugins, since it costs almost nothing.
- **Exception to the no-stubs rule:** iOS adapters are excluded from the Android build and tracked in `docs/IOS-PORT.md`. That file is a step-by-step checklist (adapters to write, push gateway, Apple account, signing, App Store/TestFlight) that a future session can follow without re-researching.
- **Android specifics:**
  - current Play target SDK;
  - a location-type foreground service with a persistent notification while sharing;
  - an in-flow prompt to exempt the app from battery optimisation, with OEM-specific guidance (Samsung, Xiaomi, etc.);
  - Android Auto is a later stretch goal; document it but don't build it.
- **Efficient builds:**
  - Windows host: put needed system-wide installs (JDK 17, Android Studio/SDK + platform-tools, Blender, Docker Desktop with WSL2, Tailscale) in the upfront checklist and ask before installing them with `winget`; keep Gradle/pnpm caches on D: where configurable; enable Git long paths.
- Build the debug/test APK locally with `npx expo run:android` / Gradle. Use EAS only if a local build isn't possible.
  - Install on my phone with `adb install` or a downloadable APK link.
  - CI builds and tests Android only, and typechecks all shared code.
  - No macOS runners, Xcode or iOS simulators.

## 3. Features (all required)

### F1. Driving tracking: real-time + per-friend stats
- Automatic trip detection (start/stop) from motion activity + speed. No manual start.
- Live current speed and posted speed limit (route `maxspeed`, or OSM `maxspeed` via map matching when not navigating), with a speeding indicator.
- Risky events detected from GPS + accelerometer/gyroscope: hard braking, rapid acceleration, harsh cornering, speeding (graded by km/h over the limit and duration), phone handling while moving (screen on + touch interaction above a speed threshold, with an "I was a passenger" override per trip that removes it from scoring), late-night driving, and crash-like spikes (crash spikes alert only me, no auto-calling).
- Thresholds live in one tunable config, are documented, and are covered by tests.
- **Trip detail page:** the route on the map, coloured by speed; event pins; distance, duration, top speed, average speed; and a 0–100 safety score.
- **Per-friend stats page:** weekly/monthly/all-time totals, score trend charts, event breakdowns, longest trip, top speed, and fun badges and leaderboards. Each user controls which stats friends can see.

### F2. Fun, interactive display
- Snapchat-Map-style energy: animated 3D avatars on the map, bouncy transitions, haptics, tap-a-friend sheets, pinch/rotate/tilt, day/night map themes that follow local sunset.
- Playful but readable; driving mode switches to a calm, high-contrast UI.

### F3. Friends, distance and emote/audio messages
- Friend list and map pins show each friend's **routed ETA in minutes and distance in km** from me (Directions/Matrix API, cached and throttled), plus battery %, current activity (driving/walking/still) and "last updated".
- **Emotes with short audio:** preset set including "Get me food", "Are we there yet?", "Where are you?", "Hurry up!", "Call me", "Honk honk", "On my way", "Miss you", plus custom recorded clips (≤5 s, max size enforced). Animated emote art is original and made by us.
- **Driver-safe delivery:** if the recipient is driving, the emote shows as a non-interactive popup in a safe empty area of the screen (never over the turn banners, speed or route line; pick the position from a layout map of occupied regions), auto-dismisses within 3 s, needs no tap, and plays its audio ducked under navigation voice. Rate limit: 1 emote per sender per recipient per 2 min while driving. The recipient can set "Driving: sound off / popups off". Also send it from the map: tap a friend's moving avatar → emote wheel.

### F4. Map as a real Google Maps replacement
- Search (addresses, POIs, my saved places, friends), route preview with alternatives, and full turn-by-turn navigation: voice, lane guidance, live traffic colouring, traffic-aware ETA, automatic rerouting, speed-limit display, and arrival.
- **Proximity moments:** pop-up + optional notification when I drive past a friend's *shared* place (e.g. their Home) or when two friends are within a configurable distance of each other. Debounced so it never spams.
- **Police, hazard and traffic alerts (required, not optional).** Build a pluggable `HazardSource` adapter layer in `packages/hazards/`. Every source normalises into one schema (`id, source, type, subtype, lat, lng, heading, street, reportedAt, expiresAt, reliability, confirmations`), and the app merges results, de-duplicates them across sources (by distance + type + time) and shows source attribution.
  1. **Waze Live Map adapter (primary source for police).** Waze's official data feed is partner-only (Waze for Cities, government agencies) and the old `/rtserver/GeoRSS` endpoint is dead. So read the JSON that the public Waze Live Map website (`waze.com/live-map`) loads for a map area. In Phase 0, open the live map, inspect its network requests to find the current alerts endpoint, parameters and response shape, and check maintained open-source projects/gists that use it. Fetch it for the bounding box around the active route or visible map (not whole regions). Throttle to at most 1 request per 2 min per area while driving, and only when someone in the circle is driving or has the map open. Cache it on-device and share the normalised alerts with the circle over the P2P layer, so one phone's fetch serves nearby friends. Map `POLICE` (+ subtypes), `ACCIDENT`, `HAZARD`, `ROAD_CLOSED` and jams into our schema. Show "Waze" attribution, a "reported X min ago" age and the thumbs-up/reliability count.
  2. **Robustness:** the endpoint is undocumented and can change or block requests. Add schema validation, a health check that alerts me (in-app admin screen + log) when it starts failing or the shape changes, a kill switch (a signed config message from the circle owner, spread over P2P), and graceful degradation to the other sources. Don't build block-evasion tooling (proxy rotation, spoofed tokens, captcha solving). If it's blocked, fall back to source 3.
  3. **Paid fallback adapter, off by default:** a third-party hosted Waze-alerts API (e.g. an Apify Waze actor). It's toggled in config with a hard monthly spending cap I set; record the cost per query in `docs/DECISIONS.md`.
  4. **Québec government feeds:** MTMD / Données Québec road works (`Travaux routiers`, CC-BY 4.0), road events/closures (including any police-control events), and photo-radar locations. Use GeoJSON/WFS, refreshed by the chore peer (Section 2A) and shared with the circle.
  5. **Mapbox route incidents** from Directions `driving-traffic`.
  6. **In-app friend reports:** police, speed trap, hazard, crash, construction, pothole. One tap while driving (big buttons, no typing), with up-/down-votes and auto-expiry, shared within the circle.
  - **Google Maps police reports:** Google offers no API for them, and its in-app reports aren't exposed to the web the way Waze's are. In Phase 0, spend a time-boxed check (≤30 min) confirming whether any legitimate or public route exists. Integrate it as an adapter if one does; otherwise record the finding in `docs/RESEARCH.md` and rely on Waze (Google-owned, and the main police-report network).
  - **Alerts while driving:** spoken + visual warning for police/hazards ahead *on the route* (e.g. 800 m / 300 m), a "still there?" confirm/deny prompt when passing (voice or one big tap, never while the next maneuver is < 200 m away), and a police-density layer on the map.

### F5. Activity stats
- Totals for distance driven and walked/run, time moving, places visited, cities visited, streaks, for me and friends (respecting visibility settings), from app-tracked data.
- **Deferred:** Health Connect / HealthKit import. Keep the `health` interface in `packages/platform/` (contract only) and note the merge-without-double-counting plan in `docs/DECISIONS.md`.

### F6. Arrival notifications
- Per-place, per-friend subscriptions: "Notify me when Alex arrives at / leaves Work". Geofences are evaluated on the arriving friend's own phone (OS geofencing APIs, with hysteresis to avoid flapping), and the event is sent to subscribers over P2P. Also "notify when friend X starts driving home" (optional per pair).

### F7. Saved places
- Add places (Home, Work, School, Gym, custom with icon/colour/radius) by search or long-press on the map.
- Each place has a **visibility toggle: Shared with friends / Only me**. Shared places sync to the circle. Private places never leave my phone except inside my own encrypted backup (tested).

### F8. Customisable 3D avatars + cars
- Blender Python pipeline in `tools/blender/` that generates a modular, low-poly, stylised (original, non-Bitmoji) character: body types, skin tones, hair, faces, tops, bottoms, shoes, hats, glasses, accessories. Also at least 8 cars (compact, hatchback, pickup, SUV, sports car, van, motorcycle, something silly), each with colour variants.
- In-app avatar editor with a live 3D preview (react-three-fiber/expo-gl or equivalent). The config is saved as JSON and composed into GLBs at runtime or from a pre-baked atlas.
- On the map: avatar standing/walking when not driving; **automatically swaps into the user's chosen car when driving is detected**, oriented to heading.
- Performance budget: ≤ 10k tris per avatar, LODs, and the friend-group map at 60 fps on a mid-range Android.
- **Decision: sprite path on the map.** Render multi-angle sprites (16 headings, idle/walk frames for avatars) from the same Blender models and pick the frame from heading. Spike (b) chooses how a custom avatar becomes sprites: layered per-part sprite sheets, or an on-device offscreen bake of the composed model cached per config. The live 3D model is used only in the avatar editor preview.
- Any third-party asset: verify licence, list it in `ASSETS_LICENSES.md`.

### F9. Inspiration
Take the best patterns from Snapchat Map (avatars, playful presence), Life360 (circles, places, driving safety, arrival alerts), Google Maps (search, routing, traffic, lane guidance) and Apple Maps (3D clarity, calm driving UI). Summarise the chosen patterns in `docs/RESEARCH.md`.

### F10. 3D extruded buildings and roads; ramps must be obvious
- 3D buildings, terrain where available, tilted driving camera.
- **Grade separation must be readable:** overpasses, bridges, tunnels and on-/off-ramps visibly stacked or shaded so I can tell a ramp is coming up. Use the map style's elevated-road rendering if available; otherwise render it ourselves from OSM `bridge`, `tunnel`, `layer` and `highway=*_link` data (raised/shadowed lines, ramp chevrons). Highlight the upcoming ramp on the active route.

### F11. Dual-turn guidance
- Main banner: next maneuver (arrow, distance, road name/shield, lanes).
- **Smaller secondary tab directly under it: the following maneuver** with its distance, always visible during guidance. It emphasises itself (size/colour/voice "then…") when the two maneuvers are close together (e.g. < 300 m or < 15 s apart).

### Cross-cutting
- **Privacy & security:** invite-only circles via in-person QR or one-time link; end-to-end encryption of everything that leaves a phone, with automated tests that non-members and removed members can't read new data; key rotation on removal; "pause sharing" / ghost mode; precise vs approximate sharing per friend; location-history retention setting (default 30 days) with scheduled purge; account + data deletion.
- **Battery:** adaptive sampling (high while driving/navigating, low when still), documented and measured in the replay harness.
- **Offline/poor signal:** queue location points and send them when back online; cache map tiles along the active route.
- **Onboarding:** permissions explained in-flow (background location, motion, notifications), avatar creation, join/create circle.

## 4. Build order

- **Phase 0:** research, stack verification, `CLAUDE.md`, `docs/RESEARCH.md`, `docs/DECISIONS.md`, and the human checklist (Section 1.1).
- **Phase 1 (spikes):** (a) 3D map with buildings + ramp readability (F10); (b) heading sprites for avatar/car on the map at 60 fps with 20 friends (F8); (c) background location + activity detection on Android, on my real phone; (d) Directions route → custom dual-turn banner (F11); (e) P2P transport (direct + Nostr store-and-forward + ntfy wake) between two phones, one backgrounded, plus the multi-peer simulator and benchmark mode (Section 2A). Record go/fallback decisions.
- **Phase 2:** monorepo, device identity, circles + invites, encrypted P2P sync, live presence, `relay/` for the fallback, and the friends map with ETA/km (F3 core).
- **Phase 3:** trip detection, risky events, trip pages, per-friend stats (F1).
- **Phase 4:** full navigation, search, traffic, hazards + friend reports, proximity moments (F4, F10, F11).
- **Phase 5:** places, arrival notifications (F6, F7).
- **Phase 6:** emotes + audio + driver-safe overlay (F3).
- **Phase 7:** avatar pipeline + editor + car swap (F8, F2 polish).
- **Phase 8:** activity stats, badges/leaderboards (F5).
- **Phase 9:** hardening (performance, battery, accessibility, i18n), CI green, release builds, docs.

## 5. Testing without a phone

Build `tools/replay/`: a GPS + motion **replay harness** that feeds recorded or synthetic drives (GPX/JSON with speed, heading and accelerometer data) into the app's location/motion pipeline in the emulator and in unit tests. Include fixtures for: a highway drive with an on-ramp/off-ramp near Montréal, a hard brake, speeding, two turns 150 m apart, arriving at a saved place, driving past a friend's shared Home, two friends converging, a walk, and a drive past a recorded Waze police alert (with a saved Waze response fixture). Use it to test trip detection, risky-event scoring, geofence arrivals, proximity pop-ups, navigation progress/rerouting and the driver emote overlay (Maestro + screenshots).

## 6. Acceptance checklist (every row must pass before you call it done)

| # | Requirement | How it's verified |
|---|---|---|
| F1a | Trips auto-start/stop | Replay test |
| F1b | Speed + limit + speeding shown live | Replay + screenshot |
| F1c | Hard brake/accel/cornering/speeding/phone-use detected | Unit tests on fixtures |
| F1d | Trip detail page with coloured route + events + score | Maestro flow |
| F1e | Per-friend stats page with trends + visibility control | Maestro + visibility test |
| F2 | Animated, interactive map; calm driving mode | Screenshots/video |
| F3a | Friend ETA in **minutes and km** (routed) | Unit + screenshot |
| F3b | All named emote presets + custom audio | Maestro |
| F3c | Driving recipient: popup in safe empty spot, auto-dismiss, no tap, audio ducked, rate-limited | Replay + overlay layout test |
| F4a | Search, route alternatives, turn-by-turn with voice, lanes, live traffic, reroute | Replay |
| F4b | Pop-up when passing a friend's shared place / friends nearby | Replay |
| F4c | Waze police/accident/hazard alerts appear on the map and are announced ahead on the route, with attribution and age | Contract test against a recorded response + live smoke test |
| F4d | Waze adapter health check, kill switch and fallback to other sources all work | Unit tests (simulated failure/shape change) |
| F4e | Québec feeds + Mapbox incidents + friend reports merged and de-duplicated | Integration test |
| F4f | Google Maps finding documented (adapter built if a route exists) | `docs/RESEARCH.md` |
| F5 | Distance driven/walked totals, streaks, places/cities visited | Unit |
| F6 | Arrival/leave notifications per place/friend, no flapping | Replay |
| F7 | Places with Shared/Only me toggle; private places never sent to friends | Integration test on sync payloads |
| F8a | Blender pipeline generates avatars, clothes, ≥8 cars | `tools/blender` run in CI or documented script |
| F8b | Avatar editor with live preview | Maestro |
| F8c | Avatar auto-swaps into chosen car when driving | Replay |
| F10 | Ramps/overpasses clearly readable; upcoming ramp highlighted | Screenshot at fixture ramp |
| F11 | Next turn + following-turn tab; emphasis on close turns | Replay with 150 m fixture |
| X1 | E2E encryption; non-members and removed members can't read new data; key rotation works | CI tests |
| X5 | Phones sync, share presence and deliver emotes/arrivals peer-to-peer, including offline catch-up and a backgrounded recipient | Multi-peer simulator + real phone check |
| X6 | Benchmark mode works; each function's transport (P2P or central PC) chosen by the Section 2A thresholds | `docs/P2P-BENCHMARK.md` |
| X7 | `relay/` starts with one command and the app switches functions to it by config | Integration test |
| X2 | Ghost mode, retention purge, account deletion | Tests |
| X3 | CI green; installable Android test APK + signed release AAB | CI + `adb install` on emulator |
| X8 | No platform-specific imports outside `packages/platform/`; every platform interface has an Android implementation (except deferred health and BLE) and an iOS contract; `docs/IOS-PORT.md` complete | ESLint rule in CI + doc review |
| X4 | No stubs/placeholders/TODOs in shipped code | Grep check in CI |

## 7. Finish

Run a self-audit against Section 6. Fix every failing row and re-run. Then give me:
1. the repo link;
2. how to install on my Android phone and invite friends;
3. any rows that used a documented fallback, and why, including the current status of the Waze adapter;
4. anything that will cost money if the group grows;
5. which functions run P2P and which (if any) use the central PC, with the benchmark numbers and how to run the battery benchmark on my phone;
6. a short summary of what's left for iOS (from `docs/IOS-PORT.md`).
7. every row that needs my real phone or a live endpoint (Waze, Mapbox, Québec feeds) and wasn't verified on them, marked "unverified", never "passed".

Keep `docs/PROGRESS.md` final and accurate.
