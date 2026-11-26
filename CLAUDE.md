# CrewMap — agent guide

Private friends' location, driving-stats and navigation app. Spec: `crewmap-prompt.md` (source of truth).
**Resuming a session:** first `git pull`, then read the latest "Status … (handoff)" section at the end of `docs/PROGRESS.md` and the `crewmap-state-handoff` memory note. They hold the current preview link, open items, build/test gotchas and owner preferences, so don't re-derive the project.
Status: `docs/PROGRESS.md`. Choices and their reasons: `docs/DECISIONS.md`. Research: `docs/RESEARCH.md`.

## Architecture (short)
- P2P-first, local-first, E2E-encrypted. No backend of ours. Phones exchange libsodium-encrypted messages over
  WebRTC data channels (direct) or public Nostr relays (store-and-forward); ntfy/UnifiedPush for content-free wake-ups.
- `relay/` is an optional blind Nostr relay for the home PC; a function moves there only via config (D13).
- Durable shared state = Yjs doc per circle; live location/emotes = ephemeral messages; raw history stays on device.
- All shared code is platform-neutral TS. Platform code only in `packages/platform/` behind interfaces; an ESLint
  `no-restricted-imports` rule enforces it.

## Layout
```
apps/mobile          Expo app (Expo Router)
packages/shared      domain logic: driving, trips, scoring, navigation progress, stats, geo, i18n
packages/p2p         crypto, circles, transport (webrtc, nostr, relay), sync, wake
packages/hazards     HazardSource adapters + merge/dedupe
packages/platform    interfaces + android/ implementations + ios/ contracts
relay/               optional central-PC blind relay (Docker Compose)
tools/replay         GPS/motion replay harness + multi-peer simulator + fixtures
tools/blender        headless Blender avatar/car pipeline
```

## Commands (run `. tools/env.ps1` or `source tools/env.sh` first — toolchain is portable under `.tools/`)
- `pnpm i` — install · `pnpm lint` · `pnpm typecheck` · `pnpm test` (Vitest, all packages)
- `pnpm android` — build + install debug on device/emulator · `pnpm sim` — multi-peer simulator
- `pnpm relay` — start the optional relay locally (or `docker compose -f relay/docker-compose.yml up`)
- `bash tools/dev-relaunch.sh` — restart Metro (clean cache) and relaunch the dev client on the USB phone
- `bash tools/device/run-maestro.sh [flow.yaml] [maestro args]` — the standard device test run: clears logcat, runs
  Maestro (`--exclude-tags destructive`), then `tools/device/collect-errors.sh end` greps logcat + dumps the app's error
  log (`crewmap://dev/errors?action=dump`) into `.cache/test-errors.txt`. Fails on Maestro failure OR any new error;
  benign noise goes in `tools/device/error-allowlist.txt` (documented). In-app log: Settings → Help → Diagnostics.
- `pnpm sim -- docs/P2P-BENCHMARK.sim.md` — multi-peer simulator benchmark
- Battery: `bash tools/device/battery-window.sh [min] [pkg]` measures GPS, wake-lock, radio and CPU time WITHOUT unplugging (never use `dumpsys battery unplug`; the script resets any override on exit).
- Device tests: `maestro test --exclude-tags destructive apps/mobile/.maestro` (Maestro in `.tools/maestro/bin`; 01_onboarding wipes app data). `scrcpy --record=x.mkv` / `--no-video --record=tts.opus` captures screen + phone audio (TTS checks); it uses our adb via `$ADB`.
- Assets: `.tools/blender/blender.exe -b -P tools/blender/build_assets.py -- apps/mobile/assets/models` then `node tools/blender/optimize.mjs apps/mobile/assets/models` (weld/dedup/quantize; no decoder needed)

## Privacy (owner rule: no personal info ever reaches GitHub)
- `node tools/privacy/check.mjs` scans for the owner's private terms and coordinates listed in git-ignored `.secrets/private-terms.txt` and `.secrets/private-places.txt`. It runs as the pre-commit and pre-push hook (`git config core.hooksPath tools/githooks`).
- Use public landmarks, never the owner's real addresses, in tests, fixtures, docs and examples.
- Public copy: `bash tools/publish-public.sh` pushes a scanned, fresh-history snapshot of HEAD to `crewmap-public`. CI runs there; the private repo skips CI to save Actions minutes.

## Release signing
- Releases are signed with the public debug key pinned in `apps/mobile/plugins/debug.keystore` (no secrets); runbook: `docs/RELEASE.md`.
- `.secrets/crewmap-upload.jks` is retired: never read, move or delete it, and never open `.env` values.

## Local compute (owner's PC: 7800X3D, 9070 XT) — use it to save Claude tokens and Actions minutes
- Local LLM (gpt-oss-20b, llama.cpp) is ON DEMAND ONLY, never auto-started: `bash tools/local-ai/start.sh` (CPU; `--gpu` uses the 9070 XT, which the owner mines on, so only when worth it), `node tools/local-ai/ask.mjs ...`, then `bash tools/local-ai/stop.sh` when done. Use it for mechanical work: log triage, fr/ru translations, first-pass diff review, boilerplate. Design and final review stay with Claude.
- Self-hosted Actions runner `crewmap-local-7800x3d` (label `crewmap-local`, `.tools/gh-runner`) runs private-repo CI. It is not auto-started: start it with `.tools/gh-runner/run.cmd`. Its `.env` puts Git Bash first on PATH (not WSL bash). Never use self-hosted runners for the public repo.
- Prefer Maestro text reports and scripted checks over screenshots (images cost the most tokens).

## Conventions
- TypeScript strict. No stubs/TODO/placeholder data in shipped code (CI grep). Seed data only behind `__DEV__` + dev flag.
- Never hand-roll crypto; only libsodium primitives via `packages/p2p/src/crypto`.
- Tunables live in one config per domain (e.g. `packages/shared/src/driving/thresholds.ts`) with tests.
- UI copy minimal: no taglines/helper text. All strings through i18n (`en`, `fr`).
- Metric units, 24 h time.
- Build/test output: report only failures + one-line summary.
- Commit at the end of each phase; keep `docs/PROGRESS.md` current.
- Subagents only for simple, isolated, test-backed leaf tasks (Opus, low effort).
