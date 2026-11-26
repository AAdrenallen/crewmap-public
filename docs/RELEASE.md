# Release (preview APK)

## Signing
Release builds are signed with the standard public React Native/Android debug key, like Govori. No password, no secret.
The keystore is pinned at `apps/mobile/plugins/debug.keystore` (file SHA-256 checked by `plugins/withReleaseSigning.js`)
and copied into `android/app/` on every prebuild, so `expo prebuild --clean` always gives the same key.

- Cert: `CN=Android Debug`, alias `androiddebugkey`, store/key password `android`
- Cert SHA-256: `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`

The old upload keystore `.secrets/crewmap-upload.jks` (CN=CrewMap) is retired. It stays on disk untouched as a backup
and nothing reads it any more. Its password has been removed from `.env.example`; you can delete the
`CREWMAP_UPLOAD_*` lines from your own `.env` (and the GitHub secrets `CREWMAP_UPLOAD_KEYSTORE_B64`,
`CREWMAP_UPLOAD_STORE_PASSWORD`, if they exist).

## Runbook
1. `. tools/env.ps1`, then `cd apps/mobile; npx expo prebuild --platform android` (only after native/config changes).
2. `cd android; ./gradlew :app:assembleRelease` gives `app/build/outputs/apk/release/app-release.apk`.
3. Check the signer: `apksigner verify --print-certs app-release.apk` shows the SHA-256 above.
4. Commit, then `bash tools/publish-public.sh` (the public snapshot; release tags point at its main).
5. `bash tools/release/publish-preview.sh [apk] [tag]` uploads `CrewMap-Preview.apk` to a dated prerelease
   (`preview-YYYYMMDD-HHMM`) and replaces the asset of the rolling `preview` prerelease (created if missing), then
   checks that the download URL answers 200 with the same size. Invites always link to the rolling URL:
   `https://github.com/AAdrenallen/crewmap-public/releases/download/preview/CrewMap-Preview.apk` (`DOWNLOAD_URL`).

## Join page (invite links)
Invites are shared as `https://aadrenallen.github.io/crewmap-public/join/#<token>`, served by GitHub Pages from the
public repo's orphan `gh-pages` branch, built from `site/` (D50).
- Publish or update the page: `bash tools/release/publish-site.sh` (privacy scan of `site/`, then a force-pushed
  single-commit `gh-pages`).
- Enable Pages once (after the first publish):
  `gh api -X POST repos/AAdrenallen/crewmap-public/pages -f "source[branch]=gh-pages" -f "source[path]=/"`
- Check: `curl -sI https://aadrenallen.github.io/crewmap-public/join/` answers 200.
- The page targets the `app.crewmap.preview` package. Changing the package, the APK name or the repo means updating
  `packages/shared/src/links.ts`, `site/join/index.html` and `app.config.ts` together (`packages/shared/test/site.test.ts`
  catches a drifted APK URL).
- `site/.well-known/assetlinks.json` is served under `/crewmap-public/`, not the host root, so Android cannot verify
  App Links from it; it only matters if the site later moves to a user site or a custom domain.

## Consequences (accepted by the owner for a friends-only app)
- **One-time reinstall.** Earlier preview APKs were signed with the CN=CrewMap key. Android refuses to update an app
  signed with a different key ("App not installed" / signature conflict), so friends must uninstall the old preview
  once, then install the new APK. The app's local data is lost on uninstall.
- **The debug key is public.** Anyone can sign an APK with it, so anyone could build a lookalike "update" that installs
  over CrewMap. Friends should only install from the official releases page.

## Google Play Protect
A stable signing key avoids signature-mismatch errors on updates, but no key removes Play Protect's
"unrecognized app" prompt for apps installed outside Play; a well-known debug key may get flagged more often.
Developer verification/registration or Play Console distribution are the real routes. Users can tap
"More details → Install anyway" (or "Scan app").
