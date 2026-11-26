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
