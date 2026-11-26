# One-time human checklist

Everything below needs you. Anything not listed, I do myself and record in `docs/DECISIONS.md`.

## Required now
1. ✅ **USB debugging authorised** (OnePlus 8 IN2015, Android 13).
2. **Mapbox sign-in** (free account, no card): sign in at account.mapbox.com with GitHub or Google. The agent copies the
   default public token (`pk.…`) into `.env` (`MAPBOX_PUBLIC_TOKEN`). No secret download token is needed anymore
   (verified: the Mapbox Maven repo serves the SDK anonymously).
3. **Windows long paths** (React Native New-Architecture builds on Windows exceed 260 chars). In an **admin** PowerShell:
   `New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`
4. **Waze probe.** My one test request to the Waze Live Map endpoint was blocked by my permission sandbox.
   Either let me run it (allow the request when I ask again), or run it yourself and I'll read the output:
   `! curl -s -m 20 -w "\nHTTP %{http_code}\n" "https://www.waze.com/live-map/api/georss?top=45.70&bottom=45.60&left=-74.40&right=-74.25&env=na&types=alerts"`
   Public reports say it now returns 403 to non-browser clients; the adapter, health check and fallback get built either way.

## Done by me, no action (tell me if you object)
- Portable toolchain under `D:\Tools\CrewMap\.tools` (Node 24 LTS, JDK 17, Android SDK + NDK ≈ 6 GB, Blender
  portable ≈ 400 MB) and all caches under `.cache`, because C: has 8.8 GB free. No system-wide installs.
- Android releases are signed with the public debug key pinned in `apps/mobile/plugins/debug.keystore` (see docs/RELEASE.md); the old upload keystore in `.secrets/` is retired, kept as a backup.
  **Back up `.secrets/` and `.env`** to your password manager: losing the key means you can't update the installed app.
- Private GitHub repo `crewmap` under `AAdrenallen`, pushed per phase.

## Optional, only if needed later (I'll ask before installing)
- **Docker Desktop + WSL2** (system install + reboot; set its disk image on D:). Only for running `relay/` in Docker on
  this PC. CI tests the relay in Docker, and it also runs with plain Node, so this is needed only if the benchmark moves
  a function to the PC.
- **Tailscale** (free personal plan) for Funnel, same condition.
- **Paid Waze fallback** (off by default): OpenWeb Ninja API key → `WAZE_PAID_API_KEY` and a monthly cap in
  `WAZE_PAID_MONTHLY_CAP_USD` (~US$0.005/request; ≈ US$4.50/month per hour-a-day driver).
- **Friends' phones:** each installs the APK I give you (and optionally the free *ntfy* app as UnifiedPush distributor for
  faster wake-ups when not sharing).
- **One overnight battery benchmark** on your phone (Developer settings → Transport benchmark) once Phase 1(e) is in.
