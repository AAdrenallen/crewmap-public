#!/usr/bin/env bash
# Publishes a release APK to the PUBLIC repo twice: a dated prerelease (history) and the rolling `preview` release whose
# asset is replaced, so the invite link's download URL always serves the newest build.
#
#   bash tools/release/publish-preview.sh [apk] [tag]
#     apk  default apps/mobile/android/app/build/outputs/apk/release/app-release.apk
#     tag  default preview-YYYYMMDD-HHMM (local time)
#
# Needs `gh` logged in. No secrets: the APK is signed with the public debug key (docs/RELEASE.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/tools/env.sh" >/dev/null 2>&1 || true
cd "$ROOT"

REPO="${PUBLIC_REPO:-AAdrenallen/crewmap-public}"
APK="${1:-apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
TAG="${2:-preview-$(date +%Y%m%d-%H%M)}"
ROLLING=preview
ASSET=CrewMap-Preview.apk
URL="https://github.com/$REPO/releases/download/$ROLLING/$ASSET"

[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }
[ "$TAG" != "$ROLLING" ] || { echo "The dated tag must differ from '$ROLLING'."; exit 1; }
SHA="$(git rev-parse --short HEAD)"

# gh names the asset after the file, so upload a copy with the fixed name.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$APK" "$TMP/$ASSET"

# The public repo only has scrubbed snapshots, so release tags point at its main branch head.
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$TMP/$ASSET" -R "$REPO" --clobber
else
  gh release create "$TAG" "$TMP/$ASSET" -R "$REPO" --prerelease --title "Preview $TAG" --notes "Preview build from $SHA."
fi

if gh release view "$ROLLING" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$ROLLING" "$TMP/$ASSET" -R "$REPO" --clobber
  gh release edit "$ROLLING" -R "$REPO" --prerelease --notes "Always the newest preview (now $TAG, from $SHA)." >/dev/null
else
  gh release create "$ROLLING" "$TMP/$ASSET" -R "$REPO" --prerelease --title "Preview (latest)" --notes "Always the newest preview (now $TAG, from $SHA)."
fi

# GitHub answers the download URL with a redirect to the asset host; follow it to the final status.
CODE="$(curl -sIL -o /dev/null -w '%{http_code}' "$URL")"
if [ "$CODE" != 200 ]; then echo "Download URL returned $CODE: $URL"; exit 1; fi
SIZE_LOCAL="$(wc -c < "$APK" | tr -d ' ')"
SIZE_REMOTE="$(curl -sIL "$URL" | tr -d '\r' | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')"
if [ -n "$SIZE_REMOTE" ] && [ "$SIZE_REMOTE" != "$SIZE_LOCAL" ]; then echo "Size mismatch: local $SIZE_LOCAL, remote $SIZE_REMOTE (CDN cache?)"; exit 1; fi
echo "Published $TAG and rolling '$ROLLING': $URL (200, $SIZE_LOCAL bytes)"
