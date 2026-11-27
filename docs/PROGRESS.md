# Progress

## Status (2026-11-24, Mapbox token in)
All phases' code is written; 69 automated tests green; lint, typecheck (all packages + app), stub check clean.
Debug build runs on the OnePlus 8 with the live Mapbox token: map, search, routing with alternatives, turn-by-turn,
live speed limit and ramp layer verified on the phone. Signed release APK + AAB build locally and in CI.

## Acceptance self-audit (prompt §6)
"passed" = verified by an automated test or on the phone. "unverified" = needs the real phone, Mapbox or a live endpoint.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F1a | Trips auto-start/stop | **passed** | `tools/replay/test/driving.test.ts`; on-device replay produced a trip (2.98 km, 208 s) |
| F1b | Speed + limit + speeding live | **passed** (live 40 km/h limit from Map Matching shown on the phone) | on-device screenshot |
| F1c | Hard brake/accel/cornering/speeding/phone-use detected | **passed** | driving tests (fixtures) |
| F1d | Trip detail: coloured route + events + score | passed (score/stats/events/passenger on device) / unverified (route map: Mapbox) | on-device screenshot; `.maestro/03_trip_detail.yaml` |
| F1e | Per-friend stats + trends + visibility | passed (unit: visibility, leaderboards) / unverified (Maestro run) | `packages/shared/test/shared.test.ts` |
| F2 | Animated interactive map; calm driving mode | **passed** (Standard 3D map, avatar sprite, calm nav UI on the phone) | on-device screenshots |
| F3a | Friend ETA in minutes and km (routed) | unverified | implemented (Matrix API); needs Mapbox + a friend |
| F3b | All emote presets + custom audio | passed (unit) / unverified (Maestro) | `shared.test.ts`, `.maestro/05_emote_presets.yaml` |
| F3c | Driving recipient: safe spot, auto-dismiss, no tap, ducked, rate-limited | passed (layout + rate-limit tests) / unverified (Maestro on device) | `shared.test.ts`, `.maestro/06_driving_emote.yaml` |
| F4a | Search, alternatives, turn-by-turn, voice, lanes, traffic, reroute | passed (live search, 2 traffic-aware alternatives, banner + next-turn tab on the phone; voice/lanes/reroute by replay) / unverified (voice heard and reroute on a real drive) | `navigation.test.ts`, on-device screenshots |
| F4b | Pop-up passing friend's place / friends nearby | **passed** | `places.test.ts` |
| F4c | Waze alerts on map + announced ahead + attribution + age | passed (contract on documented shape) / **unverified live** | `hazards.test.ts`; live endpoint reportedly 403 (RESEARCH.md) |
| F4d | Waze health check, kill switch, fallback | **passed** | `hazards.test.ts` |
| F4e | Québec + Mapbox incidents + friend reports merged/deduped | **passed** | `hazards.test.ts` (recorded Québec responses) |
| F4f | Google Maps finding documented | **passed** | `docs/RESEARCH.md` |
| F5 | Distance/walk totals, streaks, places/cities | **passed** | `shared.test.ts` |
| F6 | Arrival/leave per place/friend, no flapping | **passed** | `places.test.ts` |
| F7b | Place types + pins, place search, per-place × per-crew sharing (D30) | **passed** (device check pending) | `places-model.test.ts`, `place-sharing.test.ts` |
| F7 | Shared/Only-me; private never sent | **passed** | `p2p/test/sync.test.ts` (decrypts every outgoing event) |
| F8a | Blender pipeline: avatars, clothes, ≥ 8 cars (now 15 rides with rider poses) | **passed** | `tools/blender/build_assets.py` + `optimize.mjs`, manifest test (avatar worst case 14,898 tris, rides ≤ 3,960) |
| F8b | Avatar editor with live preview | unverified (Maestro) | `src/app/avatar.tsx`; on-device sprite bake verified |
| F8c | Avatar rides their vehicle when driving (15 rides, posed riders) | passed (logic, manifest tests, Blender pose preview) / unverified (three.js toon bake on the phone, real drive) | `buildRide` + `MapSprite` ride sheet; D48 |
| F10 | Ramps/overpasses readable; upcoming ramp highlighted | passed (ramp detection + highlight geometry; ramp layer renders on the live map) / unverified (upcoming-ramp highlight on a real drive) | `navigation.test.ts` |
| F11 | Next + following-turn tab, emphasis on close turns | **passed** (replay, 150 m fixture; "Then" tab on the phone with a live route) | `navigation.test.ts` |
| X1 | E2E; non-members/removed can't read; rotation | **passed** | `p2p/test/crypto.test.ts`, `mailbox.test.ts` |
| X5 | Sync, presence, emotes/arrivals P2P incl. offline + backgrounded | passed (simulator) / unverified (two real phones) | `sim.test.ts`, `sync.test.ts` |
| X6 | Benchmark mode + per-function choice by thresholds | passed (simulator + rule tests) / **unverified battery** | `docs/P2P-BENCHMARK.md` |
| X7 | relay/ starts with one command; app switches by config | **passed** | `relay/test/relay.test.ts`; Docker job in CI |
| X2 | Ghost mode, retention purge, account deletion | passed (ghost test) / unverified (purge/delete on device) | `sync.test.ts`; `db.purgeOlderThan`, `engine.deleteAccount` |
| X9 | Multiple crews + per-crew sharing | **passed** (logic: policy enforced on outgoing events — decrypted per crew, coarse/city/hidden presence, speed/battery stripping, stats/trips stripping, friend merge, single→multi-crew storage migration; D52 per-crew stats visibility, per-friend overrides with per-recipient presence tiers, global-settings migration) / unverified (on device: crew create/join/leave/rename UI, map crew filter, sharing screen, two live crews side by side) | `packages/p2p/test/sharing.test.ts`, `overrides.test.ts`; `core/crews.ts`, `app/crew.tsx`, `app/crew-sharing/[id].tsx` |
| X3 | CI green; test APK + signed release AAB | **passed** (CI + Android workflows green; debug APK on phone; signed APK + AAB locally) | `.github/workflows/ci.yml`, `android.yml` |
| X8 | Platform-import boundary, Android impls, iOS contracts, IOS-PORT | **passed** | ESLint rule, `packages/platform/src/*/ios/CONTRACT.md`, `docs/IOS-PORT.md` |
| X4 | No stubs/placeholders/TODOs | **passed** | `tools/check-stubs.mjs` (CI) |

## UI overhaul (2026-11-24, owner feedback)
Design system (Inter, vector icons, elevation/motion tokens) across every screen; re-modelled avatars (faces, hair,
clothing detail) and 8 bevelled PBR cars baked with studio lighting + ACES; Québec-style VITESSE/MAXIMUM sign; voice
mode toggle (on / alerts only / muted) on the driving HUD and in Settings; heading-up navigation camera (course when
moving, compass when stopped); Waze-style hazard pins with pulse for new reports; own reports never announced and
nothing announced under 150 m; search results de-duplicated; route cards with arrival time + traffic strip.
Seen on the phone: home, search, route preview, navigation HUD, sprite sheets. Unverified on the phone: report flow
end to end, voice toggle audibly muting, stats/trips/settings/places/avatar-editor restyles (typechecked only).

## Navigation map performance (2026-11-24, owner: choppy, reload on rotate)
Render path split (D28): a fix re-renders only the self sprite; constant/memoised layer styles and Standard config;
no JS camera events per frame (native steady observer, 500 ms); static hazard halo; trees/facades off and terrain
1.15 while navigating. `hazardsOnRoute` 128 -> 6 ms on a 75 km route, ramp slice per fix 7.8 -> 0.2 us (Node).
Unverified on the phone (needs the dev client relaunched; the native observer is already in the current APK).

## Bugs found and fixed on the device
Route preview now frames the whole route; own avatar hidden by the follow-mode puck (`allowOverlapWithPuck`) and missing until the first new fix (seeded at start); speed-limit sign hidden behind the ETA pill (stacked above the speed). Earlier: lib0 webcrypto import on Hermes; three.js CJS `process.emitWarning`; sprite baker (tiny default framebuffer → render
target + GL sync); string-only AEAD additional data in react-native-libsodium; Android 13 notification prompt path;
nested SQLite transactions; R8 missing WebRTC class; Windows long paths (CMake 3.31); libsodium CMake backslash path.

## Next (owner + agent)
1. Friend ETA (F3a) needs a 2nd phone in the circle.
2. Run the Maestro flows on the phone (`maestro test apps/mobile/.maestro`), install on a 2nd phone, real drive.
3. Overnight battery benchmark → fill `docs/P2P-BENCHMARK.md` §2.

## Dev notes
- `bash tools/dev-relaunch.sh`: restart Metro with a clean cache and relaunch the dev client (Metro's watcher misses
  changes in the Hermes-bytecode graph on this machine).
- Use only the D: adb (`.tools/android-sdk/platform-tools`); a second adb server from the C: SDK makes adb hang.
- A screen overlay on the test phone blocks touches in a strip near x≈940, y≈790–880 (not an app bug).

- 2026-11-24 — Navigation voice (D27): system TTS via Kotlin `NavTts` (QUEUE_ADD, per-segment voice, nav audio focus),
  mixed-language segments from `navigation/nameLang.ts`, "Voice language" setting (en/fr/ru) driving Mapbox language,
  full Russian UI locale, missing-voice detection + one-time install prompt. Needs on-device check.
- 2026-11-24 — Friends deepened (D31): drive-along (friend sheet, crew screen, route preview "Drive along with…",
  HUD button → `/drive-along`; accept/ignore/decline; 1.5 s sealed live presence among participants; companion strip,
  off-screen edge blips with tap-to-frame, shared route lines, regroup suggestion, voice cues). Ask for location, live
  auto-updating ETA share, friend battery-low alerts, one-shot arrive/leave alerts. Protocol 3 caps + compat tests.
  Needs a two-phone check.
- 2026-11-25 — Group drive (D46): fixed drive-along ending itself on the first tick (stale `parkedSince`), lost capability
  stamp on multi-crew presence merge, no live send while stationary. "Drive together" from the friend card / long-press /
  crew → destination search → route preview "Invite crewmates" → multi-select picker; invite card / driving pill with
  one-tap Join; strip shows ETA / Arrived; host destination change prompt, host hand-over, arrival summary; protocol 5 cap
  `groupDrive`; vitest (`shared/test/groupDrive.test.ts`) and 3-peer sim (`tools/replay/test/groupDrive.test.ts`).
  Needs a two/three-phone check.
- Quips (D49): jokey friend-facing emote copy (en/fr/ru); custom quips (voice/emoji/image/caption) created, sent to a friend or the crew, saved and re-sent by recipients; protocol 7 `quips`, content-addressed chunked blobs, 30 MB LRU; vitest (`p2p/test/quips.test.ts`, incl. 3-peer flow). Unverified on device (picker, record, popup Save).
- Location asks (D47): "Ask location" = "where do you want me?" (answer with place / here / pin + note -> Navigate / Drive
  together card) and "Ask to share once" (15 min / 1 h, expires on both sides) for crewmates whose policy shows me
  nothing, who now stay in the deck with "Location not shared"; protocol 6 cap `askWhere`, rate limit + mute; vitest
  (`shared/test/ask.test.ts`, `p2p/test/companions.test.ts`, `mobile/core/asksStore.test.ts`) and 2-peer sim
  (`tools/replay/test/askWhere.test.ts`). Needs a two-phone check.

## Status 2026-11-25 (handoff)
- Preview released: public repo release `preview-20261125-2113` (CrewMap-Preview.apk, app.crewmap.preview) from 05195e5. Smoke-launched OK.
- Device flows: 04, 05, 07, 08, 09 green; 02 steps pass; 03 (trip hardBrake event id) and 06 (driving emote popup) unresolved. Run flows one at a time.
- Not yet verified on 2 phones: group drive (D46), ask location (D47), quips (D49), offline emote combos.
- Open: OSM `change:lanes` solid/dashed markings (Overpass unreachable from build PC); quip image compression (needs expo-image-manipulator + native rebuild); battery window + perf snapshot not re-run; crew sheet inner-list drag.
- Build notes: android/ is prebuilt for the preview variant; re-prebuild without APP_VARIANT for the dev client. Release builds: `--max-workers=3`, `CMAKE_BUILD_PARALLEL_LEVEL=4` (OOM otherwise).
- Invite sharing — one-link invites (D50): share text = crew name + https join-page link; `site/join` page (auto-open via intent, Install = rolling `preview` APK + copies the invite); clipboard pickup in onboarding with one-tap "Join {crew}?"; both link forms accepted (paste, QR, deep link); `tools/release/publish-preview.sh`, `tools/release/publish-site.sh`. Needs a native rebuild (expo-clipboard, https intent filter) and Pages enabled.
- Two-colour looks (D54): optional trim colour for hair/top/bottom/hat/extra (shown only for styles with trims), glasses
  frame finish + lens colour with Natural/Clear (dark lenses strong, light/clear soft tint, clear lenses added to open
  frames), ride accent on every ride and Natural/tinted paint for hot dog, skateboard and carpet; cart basket and
  scooter stem take the paint. Vitest: `shared/test/avatarStyle.test.ts` (glb material checks), `avatar3d/looks.test.ts`.
  Unverified on device: lens transparency in the live stage and baked sprites, tint strengths.

- 2026-11-26 Battery staleness fix: friend's battery stuck at an old value while "updated 1 min ago". The sender only refreshed battery from expo-battery listeners (Android level listener fires only on BATTERY_LOW/OKAY), so each presence carried the level from the last charger plug event; receivers merging several crews took battery from the most precise (possibly older) presence. Now each presence tick reads the battery (no extra wake-up), a >=2 % step or charger flip publishes early (max once per 60 s), out-of-cadence presences carry the real battery instead of null, and `mergePresence` takes battery from the newest reading.
- 2026-11-26 Crew clusters (D55): overlapping friend markers merge into a count cluster; tap fits them (max zoom 19), at max zoom a list sheet (`cluster-list`, `cluster-row-<id>`) opens the usual crewmate screen; members within 25 m show a group scene from a generated 100+ pose library (`shared/src/groupPoses.ts`, `crewCluster.ts`, tests). Unverified on device: visuals, getPointInView units, tap feel.
- 2026-11-26 Per-friend sharing cleanup (D56): Same as crew | Custom segmented (`share-user-mode-crew/custom`),
  summary rows (`share-user-sum-*`), Custom reuses the crew screen's `ShareFields` (`share-user-loc-*`,
  `share-user-<flag>`, `share-user-vis-*`). Stats + per-group toggles overridable per friend; `statsAllowed` helper for
  the stats aggregate. Vitest: `p2p/test/shareSummary.test.ts`. Unverified on device: layout, light/dark, landscape.
- 2026-11-26 Stats tab + leaderboard (D57): top You | Leaderboard switch (`stats-view-you/board`) above week/month/all.
  You: headline cards for km driven / walked in the period (`stat-driven`, `stat-walked`), streak demoted to a minor line
  (data kept), measured fixed-size grid and badge cells (no % overflow, 2-line badge labels, landscape 4 cols / up to
  6 badge cols). Leaderboard: 11 category cards (`board-cat-<id>`, rows `board-<id>-<rank|me>`) ranking top 3 + me from
  `stats-agg` (protocol 9, cap `statsAgg`), sealed per friend, groups gated by `statsAllowed`; new `home` visibility
  group (default off). Vitest: `shared/test/stats-aggregate.test.ts`, `p2p/test/statsAgg.test.ts`. Unverified on
  device: all visuals, light/dark, small screens, real cross-phone delivery. Demo peers send no aggregates.

## Emotes: pings, quick picks, catch-up fanfare (D58, 2026-11-26)
Picker scroll fixed (single scroller in the sheet), Recent as a chip row, 7 backward-compatible pings, context quick
picks, favourites/pins, bursts, streak chip; per-sender collapsed notifications with Send back + 2 ping actions;
catch-up cards with confetti at the app root. Logic + tests in `packages/shared/src/emoteSuggest.ts`. Unverified on a
device: sheet scrolling/landscape, visuals, audio, notification actions from a killed app (listener lives in RootLayout).

## Route chooser quality (D59, 2026-11-26)
Alternatives drawn each in their own colour (were near-black: Standard lighting at dusk/night), colour chip + tags +
"+N min" on cards. Discovery adds two corridor probes (point exclusion on the fastest route, "stay on the highway"
via), splits only from plausible routes, end-only variants capped at one, a motorway slot; ranking cost adds
local-street / collector / left-turn / closure / hazard penalties (ETA unchanged) and stops slower routes winning on
1–2 fewer lights; reroutes use the same ranking. Corridor labels ("A-n, A-m") with local ref style, never the end
streets. Camera fits keep ≥ 300 m and ≤ zoom 17.5. Hazards for the opposite direction are ignored. Vitest:
`shared/test/routing.test.ts`, `hazards/test/direction.test.ts`, `mobile/src/ui/map/routeColors.test.ts`. Checked
against live Directions responses for a real regional trip at four departure times (motorway corridor now always in
the set; labels name the corridors). Unverified on the phone: colours by day/night, card layout, fit feel.

## Routing efficiency work (resume notes, 2026-11-26)
Done (D60, uncommitted parts committed as WIP where noted; Vitest green: `shared/test/etaBias.test.ts`, `apiBudget.test.ts`, discovery-mode block in `routing.test.ts`):
- A ETA truth: road-group bias model (`packages/shared/src/navigation/etaBias.ts`), recommend integration (risk, no-live-data cost, leave-highway rule, habit drives from `db.routeTraces()` joined with trip start, leg-trimmed preview samples). Wired into preview, reroute and re-evaluation (`apps/mobile/src/core/nav.ts`).
- B tokens: `apiBudget.ts` (shared + `apps/mobile/src/core/apiBudget.ts`, counted in `mapbox.ts getJson`), 4-min route result cache, full/warm/lean discovery, speed-limit cache in `tracking.ts maybeLimit`, search cache. Expected: repeat search of a known O/D 1–4 calls instead of ≤ 10, re-open 0; non-navigated drive Map Matching ≈ 120/h → near 0 on repeated roads.
Half-done / next steps:
- Publish own multipliers: call `StatsAggChannel.setEtaBias(crewBiasOf(fitClassModels(sampleObs(samples))))` from `crews.ts pushAggs` (receiving side done: `core/etaTruth.ts`, in memory only; persist it in kv).
- Diagnostics screen: show `useApiBudget` days (used / saved per API) in `app/settings/diagnostics.tsx` with i18n keys (en, fr).
- C not started: optional self-hosted OSRM on the relay (OSRM JSON parses with `parseMapboxRoute`; use it for probes/splits, Mapbox only for the shortlisted 1–2 routes: ≈ 3 Mapbox calls per cold search); Ontario 511 / Environment Canada alerts adapters (read their terms first); crowd "still there" already exists (votes, announcer confirm).
- Not verified on a phone. Tune `ETA_BIAS.leaveHighway` / `unknownLive` after real drives.
Owner decisions: disk/CPU for an OSRM Québec+Ontario extract on the home PC (~1 GB download, several GB processed); per-phone daily caps in `API_BUDGET`.
- 2026-11-26 D60 follow-ups done: own ETA multipliers published with stats aggregates (`crews.ts refreshEtaBias`), received biases persisted in kv (`core/etaTruth.ts`), Diagnostics shows today's API calls used / saved. Still open: C (OSRM on relay, Ontario 511 / Environment Canada adapters), phone verification.
- 2026-11-26 D62: Waze Live Map adapter re-enabled on owner request (supersedes D40); live-map smoke test on phone still unverified.

## D61 — OSM cameras + Montréal no-right-on-red (2026-11-27)
- Done: `osm` HazardSource (Overpass, weekly 0.5° cell cache, backoff, persisted, cache read on every phone); right
  turns at signals on the island of Montréal priced 8 s in ranking. Typecheck, lint, tests green.
- Unverified on device: Overpass reachability from the phone, cell persistence across restarts, camera markers/alerts
  for `osm` cameras in Ontario. Rejected: Ontario 511 (key + terms behind login), ECCC alerts (deferred, polygons).

## D63 — Crew-sensor insights (2026-11-27)
- Done: road roughness/pothole cells, learned stop delays, leave-by in `packages/shared/src/insight/` with tests. Source sweep + ideas backlog in RESEARCH.md.
- Not wired into the app; thresholds untuned on real drives.

## D64 — Free map-point feeds, official Québec fuel prices (2026-11-27)
- Done: Régie essence Québec station prices (chore peer, 10 min, conditional GET, kv cache, shared as `pois`), MTMD
  traffic cameras (weekly, link to the Québec 511 viewer), OSM fuel + chargers (shared Overpass cell cache, 30 days),
  optional Open Charge Map (needs `OCM_API_KEY`), map layer + point sheet with price / grade / age + credits, fuel search
  (grade chips, cheapest / nearest), Diagnostics counters. Typecheck, lint, tests green.
- Unverified on device: gzip GeoJSON decode via RN fetch, kv size of the province snapshot (~600 kB JSON), pins and
  labels at zoom, formSheet layout, Linking to the 511 viewer, `pois` sharing between phones, OCM with a real key.
- Owner to confirm: reuse of the Régie file (no licence text published; see D64).

## D70 — Road-weather warnings + free trip feeds (2026-11-27)
- Done: ECCC alerts + MTMD conditions as a once-per-zone route warning (voice, haptic, banner, credit); CBSA border
  waits on routes through QC/ON ports; Wikipedia card on the place sheet. Vitest: `hazards/test/roadWeather.test.ts`,
  `hazards/test/info.test.ts`.
- Unverified on a phone: banner placement/landscape, spoken wording en/fr/ru, ECCC fetch from the phone, place card.

## D67 — Where did I park (2026-11-27)
- Done: `packages/shared/src/parking/` (classification, session reducer, Overpass query/parse, walking route, share
  text) with Vitest (`shared/test/parking.test.ts`, fixtures `parking-street|driveway|lot.json`: synthetic Overpass
  around public landmarks) and replay (`tools/replay/src/runParking.ts`, `test/parking.test.ts`: street park saved,
  home driveway skipped, parking lot saved, drive away clears, sync-payload privacy). App: `core/parking.ts`,
  tracking hooks, `ui/map/ParkedCar.tsx`, `app/parked.tsx`, settings rows, `parked` notification route.
- Unverified on a phone: parked-car sprite bake and look (light/dark, landscape), sheet layout, Overpass from the
  phone, walk line, notification from background, real driveway/street classification quality.

## D66 — Ambient safety check-in (2026-11-27)
- Done: pure monitor + stop assessment + Overpass count lookup (`packages/shared/src/safety/`), opt-in per crew / per
  friend (`checkIn` on policy and override, `checkInAllowed`), `check-in` sealed kind, app service
  `apps/mobile/src/core/checkIn.ts` wired from `tracking.ts` (fixes, activity, crash) and `engine.ts` (receiver, also on
  headless wake), "I'm OK" notification action + in-app card, friend-screen alert banner, wait setting, opt-in switch in
  onboarding / new crew / join. Vitest: `shared/test/checkIn.test.ts`, `p2p/test/checkInShare.test.ts`,
  `mobile/src/core/checkInNotif.test.ts`, `tools/replay/test/checkIn.test.ts`.
- Unverified on a phone: timer firing while still with the screen off (Doze), notification button from the lock screen,
  card look in light/dark/landscape, Overpass from the phone, real cross-phone delivery, false-positive rate on real
  drives (tune `CHECK_IN` thresholds). Maestro flows that join by link now see one more screen (`join-continue`).

## D65 — Convoy mode (2026-11-27)
- Done: `shared/companions/convoy.ts` (tracker, order, along-route distance/time gaps, lights, callouts, regroup watch,
  follow line, crew-for-mute, arrival gaps), `convoy` op + leader rules in `session.ts`, `NavRoute.signalsAlongM`.
  App: `core/companions.ts` (convoy loop, leader route share, follow), `core/convoyPrefs.ts`, strip order badges +
  regroup banner (`ui/drive/Companions.tsx`), follow pill + "+N min" summary (`GroupDrive.tsx`), convoy section on
  `/drive-along`, order on map name chips. Vitest `shared/test/convoy.test.ts`; replay `tools/replay/test/convoy.test.ts`
  (3 cars over the simulated relays: order, ~20 s time gap, exactly one regroup alert on leader + car ahead).
- Unverified on a phone: follow route quality (via-constrained Directions), callout wording/timing en/fr/ru, strip and
  banner layout in landscape, map chip order, two real phones' clocks (time gaps use sender fix times).
- Seen in the simulator: with direct links enabled (`SimDirectNet` natSuccess 1 or default 0.55) one pair of phones
  sometimes never received the other's `presence-live`; relays-only delivers. Worth a look in the direct-link path.

## D68 — Trip memories (2026-11-27)
- Done: grouping/highlights/playback/season logic in `packages/shared/src/memories` (Vitest `shared/test/memories.test.ts`,
  public Montréal landmarks), sealed per-member wire + photo chunks in `packages/p2p/src/memories.ts` (Vitest
  `p2p/test/memories.test.ts`), `platform.photos` (Kotlin `PhotoTools.kt`: compress + MediaStore share), app service
  `core/memories.ts` (records crewmate fixes / emotes while driving, rebuilds outings at trip end, sends recap, photos,
  reactions), screens `/memories`, `/memories/[id]`, `/memories/season`, `/memories/camera`, root `RecapCard`, Drives
  header entry `trips-memories`. i18n en/fr/ru. DB migration 5 (mem_tracks, mem_events, memories).
- Needs a new dev client build (Kotlin `photoCompress` / `photoShare`).
- Unverified on a phone: playback smoothness with several MarkerViews, svg `toDataURL` output (fonts/emoji in the
  card), MediaStore share sheet, camera capture + compression sizes, two-phone delivery of posts/photos/reactions,
  recap card timing after a real group drive, light/dark/landscape layouts.
- UI review: structure, i18n parity (72 mem keys en/fr/ru), a11y, playback controls already fine; added success haptic on RecapCard appear.
