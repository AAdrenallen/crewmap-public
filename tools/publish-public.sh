#!/usr/bin/env bash
# Publishes a scrubbed snapshot of HEAD to the PUBLIC repo (fresh history, no private commits).
#
#   bash tools/publish-public.sh            # snapshot HEAD -> public repo `crewmap-public` (created on first run)
#
# Safety: the snapshot is built from `git archive HEAD` (only tracked files; .env, .secrets, keystores are ignored),
# then tools/privacy/check.mjs must pass on it, or nothing is pushed. The private repo keeps the full history.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tools/env.sh" >/dev/null 2>&1
cd "$ROOT"

PUBLIC_NAME="${PUBLIC_NAME:-crewmap-public}"
OWNER="$(gh api user -q .login)"
WORK="$ROOT/.cache/public-repo"
SNAP="$ROOT/.cache/public-snapshot"

[ -f .secrets/private-terms.txt ] || { echo "Refusing: .secrets/private-terms.txt missing (the scan would be empty)."; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then echo "Refusing: commit your changes first (the snapshot is HEAD)."; exit 1; fi

rm -rf "$SNAP" && mkdir -p "$SNAP"
git archive HEAD | tar -x -C "$SNAP"
# Never publish local-only material even if it were tracked by mistake.
rm -rf "$SNAP/.secrets" "$SNAP/.env" "$SNAP"/*.keystore "$SNAP"/**/*.jks 2>/dev/null || true

node tools/privacy/check.mjs --tree "$SNAP"

if ! gh repo view "$OWNER/$PUBLIC_NAME" >/dev/null 2>&1; then
  gh repo create "$OWNER/$PUBLIC_NAME" --public --description "CrewMap: private, peer-to-peer friends map, driving stats and navigation (Expo / React Native)" >/dev/null
fi
if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK" && mkdir -p "$WORK"
  git -C "$WORK" init -q -b main
  git -C "$WORK" remote add origin "https://github.com/$OWNER/$PUBLIC_NAME.git"
  git -C "$WORK" fetch -q origin main 2>/dev/null && git -C "$WORK" reset -q --soft origin/main || true
fi
git -C "$WORK" config core.hooksPath /dev/null
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$SNAP"/. "$WORK"/
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then echo "Public repo already up to date."; exit 0; fi
SHA="$(git rev-parse --short HEAD)"
git -C "$WORK" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "Snapshot $SHA"
git -C "$WORK" push -q -u origin main
echo "Published snapshot $SHA to https://github.com/$OWNER/$PUBLIC_NAME"
