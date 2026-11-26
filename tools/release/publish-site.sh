#!/usr/bin/env bash
# Publishes site/ (the invite join page) as a fresh orphan `gh-pages` branch of the PUBLIC repo.
#
#   bash tools/release/publish-site.sh
#
# Served at https://aadrenallen.github.io/crewmap-public/ once Pages is enabled on gh-pages (docs/RELEASE.md).
# Enable Pages once: gh api -X POST repos/AAdrenallen/crewmap-public/pages -f "source[branch]=gh-pages" -f "source[path]=/"
# The privacy scan must pass on site/ or nothing is pushed. History is replaced on every publish.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/tools/env.sh" >/dev/null 2>&1 || true
cd "$ROOT"

REPO="${PUBLIC_REPO:-AAdrenallen/crewmap-public}"
WORK="$ROOT/.cache/public-site"

[ -f .secrets/private-terms.txt ] || { echo "Refusing: .secrets/private-terms.txt missing (the scan would be empty)."; exit 1; }
[ -f site/join/index.html ] || { echo "site/join/index.html missing"; exit 1; }
node tools/privacy/check.mjs --tree site

rm -rf "$WORK" && mkdir -p "$WORK"
cp -a site/. "$WORK"/
git -C "$WORK" init -q -b gh-pages
git -C "$WORK" config core.hooksPath /dev/null
git -C "$WORK" add -A
git -C "$WORK" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "Site $(git rev-parse --short HEAD)"
git -C "$WORK" push -q --force "https://github.com/$REPO.git" gh-pages
echo "Pushed site/ to $REPO gh-pages"
