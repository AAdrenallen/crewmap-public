# Battery: adaptive sampling + radio governor

Code: `packages/platform/src/location/android.ts` (`PROFILES`), `apps/mobile/src/core/tracking.ts` (cadences, tick,
activity interval, "here" fence), `apps/mobile/src/core/engine.ts` (radio governor), `packages/p2p/src/demand.ts`
(viewer demand). Research: docs/RESEARCH.md "Battery research". Decision: D33.

| Profile | When | FLP priority | Fix interval / distance | JS batch (bg) | Presence watched / unwatched | AR sampling | IMU |
|---|---|---|---|---|---|---|---|
| navigating | turn-by-turn | HIGH_ACCURACY | 1 s / 0 m | — | 4 s / 4 s | 10 s | 20 Hz |
| driving | trip / in vehicle | HIGH_ACCURACY | 2 s / 5 m | — | 5 s / 15 s | 10 s | 20 Hz |
| walking | walking/running/cycling | BALANCED | 30 s / 30 m | 60 s | 30 s / 120 s | 10 s | off |
| still | otherwise | LOW_POWER (no GNSS) | 300 s / 100 m | 15 min | 5 min / 15 min | 120 s | off |

- **Still**: GNSS is off. Movement is caught by Activity Recognition transitions (always registered) and by a
  150 m exit geofence around where the phone stopped (`crewmap-here`, re-armed on exit). The housekeeping tick
  slows from 30 s to 120 s.
- **Viewer demand (protocol 4, cap `viewerDemand`)**: while the app is in the foreground, a phone broadcasts a `watch`
  message ("until t", TTL 150 s, renewed every 120 s), and "until 0" when it leaves the foreground.
  - Senders use the unwatched cadence when nobody watches. A friend opening the app triggers one fresh presence
    (`publishNow`, at most once every 15 s).
  - Peers known to run an older build always count as watching.
- **Radio governor (engine)**: after 3 min backgrounded, still, with no drive-along and no un-acked message, every
  relay socket and WebRTC link is closed. Nothing sends keep-alives or ICE consent checks, and no radio tail runs.
  - It reopens for 45 s on a UnifiedPush ping, a WorkManager periodic sync, or before an arrival alert.
  - It reopens fully on foreground or any movement profile, and publishes one presence on reopen.
  - Replay starts from the crew's last-online stamp, which stops advancing while closed (D-catch-up preserved).
- **Fewer relays when direct**: a durable message already delivered over WebRTC keeps one relay copy instead of three.
- Keep-alives: one shared pool, pings every 2 min (relayPool.ts); the last-online write runs every 5 min (was 60 s).
- **Map**: the follow camera (Mapbox's own 1 Hz HIGH_ACCURACY provider) is enabled only while the app is in the
  foreground (CrewMapView, coordinated with the CPU/RAM agent).

## Measurements (OnePlus 8, 2026-11-24)
- **Before, `dumpsys location`** (app backgrounded, screen off, phone still): CrewMap held four FLP requests.
  - Two were HIGH_ACCURACY at 1 s (fastest 166 ms and 1 s / 0.1 m): Mapbox follow-camera providers that stayed
    active in the background.
  - One was PASSIVE.
  - One was our still profile (BALANCED 60 s / 50 m).
  - The fused engine reported `GpsBatch interval=1000ms, NoBatching`, i.e. **GNSS on continuously while idle**. That
    alone is the dominant idle drain, roughly Maps-navigation-level GNSS cost with the screen off.
- batterystats before/after: **not obtained**. The phone was on USB (time on battery 0 ms). A retry with the
  `dumpsys battery unplug` override lost the adb connection mid-window. After changes, `dumpsys location` should show
  only LOW_POWER @5 min while still; re-check with `adb shell dumpsys location | grep -A3 crewmap`.
- **Simulator** (`pnpm --filter @crewmap/replay sim`; idle-8h now models the governor: all phones closed, wake-only):

| Scenario | Before: emotes / arrivals / relay events | After |
|---|---|---|
| drive-1h p2p | 100 % / 100 % / 2490 (staleness p95 5 s) | 100 % / 100 % / 2405 (p95 5 s) |
| idle-8h p2p | 98.7 % / 100 % / 3084 | 98.7 % / 100 % / 2455 (−20 %) |

## Comparison limits
- Life360 and Google Maps publish no official drain figures. Community or third-party ranges are about
  5–15 %/day for Life360 and about 10–20 %/h for Maps navigation, screen on (*unverified*).
- Our device numbers are still missing. The structural comparison: while still, CrewMap now matches Life360's model
  (AR + geofence, no GNSS) without its server pings. While navigating, GNSS cost equals Maps (1 Hz) and the
  screen/GPU share belongs to the CPU/RAM pass.

## Remaining gaps
- expo-location forces maxUpdateDelay = interval, so no hardware batching. True batching (and PASSIVE when still)
  needs a small native location module or a patch.
- The location FGS also runs while still. It keeps the process alive for AR/geofence handling. Dropping it needs
  Kotlin-side headless restart on transition/geofence PendingIntents.
- A 20–30 min unplugged batterystats window before/after, and the in-app 8 h Transport benchmark.

## How it is measured
- **Simulator** (`pnpm sim`): network behaviour only — staleness, delivery, relay event counts.
- **On the phone**: Settings → Developer → Transport benchmark (1 h / 3 h / 8 h), unplugged; or
  `dumpsys batterystats --reset` → idle window → `dumpsys batterystats --charged app.crewmap`.

## OEM guidance
Onboarding shows "Battery steps" on OEM phones and deep-links the vendor's auto-start/battery screen
(`CrewmapPlatformModule.oemBatteryIntents`). **OnePlus 8 (Android 13, OxygenOS 13):** Settings → Battery → Battery
optimisation → CrewMap → Don't optimise; App info → Battery → Allow background activity.

## Efficiency scan (2026-11-25)
- Friend drive times (D45): no Matrix calls with the screen off or backgrounded without the overlay, none while
  everyone is still, and dead-reckoned numbers between calls. Only changed values patch the store.
- `SyncChip` polled connectivity every 3 s in the background too, and set a new object each time, so the map
  re-rendered every 3 s. Now foreground only (`useActiveInterval`) and it keeps the old object when nothing changed.
- `useNow` ("x min ago" labels): foreground only, and it catches up on resume.
- Checked and left alone: hazard cycle (already state-tied, D44), reverse geocode (already deduped in
  `friendPrefs`), drive-along blips (already signature-compared), map motion timers (stop when not animating).
- Bigger items not touched: `Sprites` keys built with `JSON.stringify(cfg)` per render (cheap, small objects);
  `engine.ts` logs installed TTS voices at start (one-off). Next: measure presence JSON encode per broadcast with
  device numbers before changing the wire format.
