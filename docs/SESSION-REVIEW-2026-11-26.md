# Session review (2026-11-25 to 2026-11-27)

Everything done in the long session, what is verified, what is not, and what the owner still wants. Read this first when resuming (after `git pull`). Decisions are in `docs/DECISIONS.md` (D46 to D59+), status in `docs/PROGRESS.md`.

State: everything below is committed locally on `main`; the public repo and the rolling `preview` release only contain up to the Voice/privacy work (see "Published"). Nothing after that is pushed. No new preview has been built since.

## Published (public repo `crewmap-public`, single clean commit, rolling `preview` release)
- Release APK signed with the public debug key (no password). Install only from the official releases page.
- Privacy scrub: street/place names removed from code, fixtures, docs and the voice sample. Old commits of the public repo may still be fetchable by SHA until the repo is deleted and recreated (needs `gh auth refresh -h github.com -s delete_repo`; owner has not done it).
- One-link invites, join page on GitHub Pages, clipboard pickup on first launch.

## Built and committed but NOT in any preview yet (all unverified on a device)
- Avatar: finishes follow the chosen colour (rainbow, trippy, holo, prismatic, galaxy, lava, ice, leopard); galaxy motion visible on small parts; trim colour fields (hair, top, bottom, hat, extra); glasses lens colour (Natural/Clear, dark lenses strong tint, tinted 60 percent, clear 30 percent) and frame finish; every ride has accent colour; Natural option for hot dog, wood deck, rug (D54).
- Models: 9 new bottoms (kilt, capris, flares, harem, chinos, bike shorts, board shorts, cutoffs, palazzo), detailed jeans/chinos, shoe heel counters and recolourable laces, new pixel shades, ski goggles with a proper eye shield.
- Editor: swipe-to-turn touch layer above the GL view, hat view zoomed out, divider between categories and options.
- Notifications: heads-up `crew` channel (invites, messages, emotes), quiet banner next to in-app bubbles, location foreground-service notification at minimum importance.
- Battery staleness fixed (sender read on each presence tick, early send on 2 percent change or plug/unplug, receiver takes newest battery).
- Shout recording: live countdown from real mic start, release-before-ready no longer records the full limit, taps under 0.4 s dropped.
- Ask location only replaces Locate when the crewmate is not sharing a position.
- Crew clusters on the map (merge radius, zoom-to-fit, group scenes from 100+ generated poses, list sheet) (D55).
- Score tab: layout fixes, You | Leaderboard switch, month km driven and walked as headline stats, 11 leaderboard categories, `stats-agg` P2P message with per-group sharing policy (D57).
- Sharing UI: Same as crew | Custom per person, shared rows with the crew screen, stats toggles (D56).
- Emotes: scrollable sheet (root cause was only the inner Recent list being the nested scroller), Recent chip row, 7 new pings, context picks, favourites, bursts, per-sender notifications with action buttons, catch-up fanfare (D58).
- Routing (D59): per-candidate route colours (the black lines came from the Standard style darkening custom layers at dusk), minimum fit span 300 m and max fit zoom 17.5, corridor probes, road-class ranking costs, corridor labels ("via A-n"), direction-aware hazards.
- Routing efficiency work (ETA truth loop, Mapbox call reduction, extra data sources): see "Routing efficiency work (resume notes)" at the end of `docs/PROGRESS.md`.

## Known problems / unverified
- At the weekday evening peak Mapbox still rates a local back-road shortcut 5 to 6 minutes faster than the motorway; the owner reports it never saves time. The ETA-truth loop (learned per-corridor correction) is the planned fix; one setting ("min gain to leave the highway") also exists.
- Nothing from this list has been seen on a phone: shaders (finishes, lenses), new models, cluster scenes, sheet scrolling, notification buttons when the app is fully closed, route colours by day and night.
- Maestro flows 03 (hard brake event) and 06 (driving emote popup) failed before this session and the owner says they worked earlier: bisect git history (devReplay.ts, riskyEvents.ts, EmoteOverlay.tsx, driveUx.ts) before assuming the flows are stale. Flow 04 was changed and never run.
- Cluster merge radius assumes `getPointInView` returns dp; if clusters merge too little on Android it returns pixels (about 2.6 times too small).
- Group scenes cannot pose arms (rig has no arm poses); hugs are suggested by arrangement only.
- Emote notification action buttons when the app is closed: the handler lives in the root layout (weakest spot).
- Leaderboard: a friend only appears after updating and sending once; "time with crew" and "drives per day" style stats have no data source; demo peers send nothing.
- Places, emotes and chat sharing stay crew-wide (the data model cannot restrict them per person).
- Release build gotcha: after changing assets only, Gradle can reuse a stale JS bundle. Force with `./gradlew :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease`. Codegen can race with parallel workers; delete `node_modules/react-native-libsodium/android/build/generated` and `node_modules/react-native-get-random-values/android/build/generated`, then rebuild. Build with `--max-workers=3`, `CMAKE_BUILD_PARALLEL_LEVEL=4`, with Minecraft and other big apps closed.
- Re-optimizing `cars.glb` can break the accent-material test; avatar-only Blender runs should `git checkout apps/mobile/assets/models/cars.glb` afterwards.

## Things the owner wants that are not solved yet
- Real Jackal voice: declined. We do not clone or bundle any real person's or game's voice. The emote voice is an original cheery Piper voice (tools/voice/build.mjs). Owner liked the idea of "inspired by"; tone is cheery, quick, bright.
- Beat Google Maps / Waze on routing, traffic and police data: in progress (see routing resume notes); live Waze data only through the existing unofficial adapter with kill switch; no official Google/Waze data access exists.
- Real solid vs dashed lane markings need OSM `change:lanes`; Overpass was unreachable from the sandbox. Lanes stay dashed.
- Fully purge old commits from the public repo (delete and recreate; needs the `delete_repo` scope).
- Quip images over 80 KB and GIFs over 250 KB are refused (needs expo-image-manipulator and a native rebuild).
- Mapbox token is embedded in the public APK: usage cap or a separate preview token not decided. The Mapbox logo cannot be removed under the licence; moved top right.
- Play Protect warning: owner said to ignore it.
- Deleting the fake dev replay trips in the real history needs the owner's yes.
- Old `CREWMAP_UPLOAD_*` lines in `.env` and GitHub secrets can be deleted by the owner.
- Battery window test and performance snapshot have not been re-run since the battery changes (`tools/device/battery-window.sh`, never unplug).
- Real coordinates near the owner's region still exist in fixtures and dev data (names are scrubbed); shifting them would break feed-coverage tests.

## Owner rules to keep
Personal use only, never published to stores. No personal info on GitHub (privacy hook scans git-ignored `.secrets/private-terms.txt`). Never uninstall or clear the owner's app data; Maestro only with `--exclude-tags destructive` and one flow at a time; never `dumpsys battery unplug`; no cloned voices; no passwords or accounts created for the owner; flag costs; keep UI copy minimal (tips only in Settings > Tips); jokey tone only for friend interactions; subagents default to Sonnet low, Opus low/medium when asked.

## Next steps when resuming
1. `git pull`, run `pnpm -s typecheck && pnpm -s lint && pnpm -s test && node tools/privacy/check.mjs`.
2. Finish or review the routing efficiency work (resume notes in PROGRESS.md).
3. Build the preview (release variant, see gotchas), verify signature fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c and package `app.crewmap.preview`, smoke-launch on the phone.
4. `bash tools/publish-public.sh`, `bash tools/release/publish-site.sh` (only if `site/` changed), `bash tools/release/publish-preview.sh <apk>`, copy the rolling link to the clipboard.
5. Device pass on the unverified list above, then the Maestro regressions.
