# Driving detection, events and scoring

All tunables: `packages/shared/src/driving/thresholds.ts` (one config). Tests: `tools/replay/test/driving.test.ts`
(replay fixtures) — every threshold below has a fixture that crosses it.

## Trips (automatic, no manual start)
- Start: speed ≥ 25 km/h (or ≥ 10 km/h with Activity = in vehicle, confidence ≥ 60) sustained 20 s; the trip is
  back-dated to the first moving fix.
- End: stopped (< 5.4 km/h) for 3 min, or walking/still activity with < 9 km/h for 60 s (parked and walked away), or a
  GPS gap > 10 min. Trips < 500 m or < 2 min are discarded.

## Risky events
| Event | Rule | Severity |
|---|---|---|
| Hard brake | Δspeed/Δt over 2 s ≤ −3.4 m/s² from ≥ 15 km/h | ×1.25 moderate, ×1.6 severe |
| Rapid acceleration | ≥ 3.0 m/s² at ≥ 15 km/h | same bands |
| Harsh cornering | v × yaw rate ≥ 3.0 m/s² for ≥ 1 s at ≥ 20 km/h | same bands |
| Speeding | ≥ 10 km/h over the limit for ≥ 10 s (4 s grace) | +10 minor, +20 moderate, +30 severe |
| Phone handling | screen unlocked + interactive while ≥ 15 km/h (touches merge within 10 s); not while navigating | ≥ 10 s moderate, ≥ 30 s severe |
| Late night | ≥ 5 min driving between 00:00 and 05:00 local | — |
| Crash-like | ≥ 4 g IMU spike at ≥ 20 km/h, then stopped within 15 s | alerts only the owner; never scored; no auto-calling |

GPS-derived acceleration is orientation-independent (the phone can be anywhere in the car); the IMU is used only for
crash spikes. Android can't see touches in other apps without an accessibility service, so phone handling uses the
unlocked-and-interactive signal (DECISIONS D17).

## Score (0–100)
Penalty points per event (by severity), speeding/phone also per second; normalised per 20 km of exposure;
`score = 100·exp(−P/50)`. "I was a passenger" removes the trip from scoring (DECISIONS D16). Stats use distance-weighted
averages; passenger trips are excluded from totals.

## Speed limit
Navigating: route `maxspeed` annotations. Otherwise: Mapbox Map Matching `maxspeed` on the last 10 fixes, at most every
30 s while driving.

## Driver interaction (minimum interruption, fewest touches)
Rules (`apps/mobile/src/ui/drive/driveUx.ts`, tests in `driveUx.test.ts`): moving ≥ 10 km/h, stopped after < 3 km/h
for 4 s. Moving hides secondary controls (search, recenter, drive-along) and enlarges primary targets to 76 dp (64 dp
stopped). Social items (crew chat, friend moments) are queued as one small chip while moving and released at the next
stop away from a manoeuvre (< 250 m); safety items always show. No modal opens by itself while moving.

| Interaction | Touches | Glance (est.) | Behaviour |
|---|---|---|---|
| Report (e.g. police) | 2 (FAB → tile) | < 2 s each | 64–76 dp targets; grid auto-closes after 6 s; spoken "{type} reported" |
| Emote receipt | 0 | < 1 s | pill only while moving; confetti burst when stopped |
| Chat / friend events | 0 | 0 while moving | queued → one "n waiting" chip; moment toast shows at a stop |
| "Still there?" | 1 (Yes/No 130×64) | < 2 s | spoken prompt; never < 200 m from a turn; auto-dismiss 8 s |
| Faster-route offer | 1 (Take) or 0 | < 2 s | card above the footer, held back < 250 m from a turn, spoken once (voice on), auto-dismiss 20 s |
| Drive-along strip | 0 | < 1 s | passive; picker button only when stopped |
| Voice toggle | 1 | < 1 s | 64 dp, cycles on → alerts → muted |
| ETA pill | 0 (1 tap or swipe up for details) | < 1 s | details: arrival, share ETA; auto-close 10 s |
| End navigation | 1 | < 1 s | 64–76 dp; hardware back asks first |
| Search | 0 while moving | — | shown only when stopped (or not navigating and stopped) |
| Music | 1 (MusicButton, thumb column) | < 1 s | MusicCard above the speed badge, collapsed while moving |

Not done: voice commands ("report police") — the platform layer has TTS only and on-device speech recognition needs a
new native module (no new native deps allowed). Night mode: the drive theme is always dark and the map follows the sun
light preset. Trip end: a 6 s "smooth drive · n min" card after a clean driver trip ≥ 5 min (store `lastTripEnd`).
