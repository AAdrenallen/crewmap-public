# P2P vs central-PC benchmark

Decision rule (prompt §2A): move a function to the PC relay only if P2P costs > 25% extra battery, p95 staleness of a
driving friend exceeds 60 s, emote/arrival delivery falls below 98% within 30 s, or fps visibly drops — and only if
the relay measures better. Logic: `packages/p2p/src/benchmark.ts` (`suggestConfig`, unit-tested).

## Current configuration: **P2P for every function** (no central PC needed)

| Function | Transport | Evidence |
|---|---|---|
| presence | P2P | simulator p95 staleness 5 s while driving |
| emotes | P2P | simulator 98.7% delivered ≤ 30 s to a dozing phone over 8 h (limit 98%) |
| arrivals | P2P | simulator 100% |
| sync | P2P | CRDT catch-up after offline periods verified in tests |
| chores, wake | P2P | ntfy.sh + public relays |

## 1. Multi-peer simulator (network behaviour)
8 phones, real crypto/router/relay engine, 3 public relays (60–350 ms, 1% loss, 2% downtime) vs 1 PC relay
(30–120 ms, 0.2% loss, 1% downtime), 55% NAT success for direct links, hourly 2-minute network blips on sharing phones,
dozing recipients that wake only via ntfy pings or the 15-min periodic sync. Reproduce: `pnpm sim -- docs/P2P-BENCHMARK.sim.md`
(also runs in CI and uploads the report).

### Simulator results

| Scenario | Mode | Phones | Driver staleness p50 / p95 (s) | Emotes → dozing phone | Arrivals → dozing phone | Relay events | Direct share | Wake pings |
|---|---|---|---|---|---|---|---|---|
| drive-1h | p2p | 8 | 3.0 / 5.0 | 100.0% (30/30), p95 7.5 s | 100.0% (4/4), p95 0.8 s | 2371 | 38.1% | 28 |
| drive-1h | relay | 8 | 3.0 / 5.0 | 100.0% (30/30), p95 7.2 s | 100.0% (4/4), p95 0.4 s | 2803 | 47.8% | 28 |
| idle-8h | p2p | 8 | — | 98.7% (229/232), p95 8.1 s | 100.0% (32/32), p95 0.9 s | 3075 | 29.2% | 217 |
| idle-8h | relay | 8 | — | 98.7% (229/232), p95 7.9 s | 100.0% (32/32), p95 0.4 s | 3114 | 26.8% | 217 |

### Switch-rule verdict (network part)

| Function | Transport | Why |
|---|---|---|
| presence | P2P | p95 staleness 5.0 s (limit 60 s) |
| emotes | P2P | worst delivery 98.7% within 30 s (limit 98.0%) |
| arrivals | P2P | worst delivery 100.0% within 30 s (limit 98.0%) |

Note: emote delivery in the 8-hour run is limited by *senders* losing connectivity mid-retry, identical for P2P and
relay — the PC relay would not help, so the rule keeps P2P.

## 2. On-device battery benchmark (needs your phone) — **not yet run**
Battery, fps and real-network staleness can only be measured on the phone. Run once (e.g. overnight, unplugged):
1. Install the app and join the crew with at least one other phone (the benchmark probes friends' phones).
2. Settings → Developer → Transport benchmark → **8 h** → start. Leave the phone unplugged.
   Phases: baseline (sharing/network paused, minimal location service) → P2P → PC relay (only if a relay URL is set).
3. Next morning: the report appears in the same screen with a suggested config; tap Share and paste it below.
   The suggestion is applied only if you switch the toggles in Developer → Transport.

| Phase | Hours | Drain %/h | Staleness p50/p95 (s) | Delivery ≤ 30 s | fps p10 | JS heap MB |
|---|---|---|---|---|---|---|
| baseline | — | unverified | — | — | — | — |
| p2p | — | unverified | unverified | unverified | unverified | unverified |
