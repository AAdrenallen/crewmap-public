#!/usr/bin/env bash
# Standard device test run: collect start -> Maestro (destructive flows excluded) -> collect end.
# Fails when Maestro fails OR new errors appear in logcat / the app's error log. Extra args go to `maestro test`.
#   bash tools/device/run-maestro.sh [apps/mobile/.maestro/05_emote_presets.yaml] [--device X]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/tools/device"
FLOWS="$ROOT/apps/mobile/.maestro"
ARGS=("$@")
if [ ${#ARGS[@]} -eq 0 ] || [[ "${ARGS[0]}" == -* ]]; then ARGS=("$FLOWS" "${ARGS[@]}"); fi

source "$ROOT/tools/env.sh" >/dev/null 2>&1
# Owner's phone settings must survive a run (Maestro's UiAutomation driver has cleared the floating a11y button before).
snap() { for k in accessibility_button_targets enabled_accessibility_services accessibility_shortcut_target_service; do
  echo "$k=$(adb shell settings get secure "$k" | tr -d '\r')"; done; }
BEFORE="$(snap)"
bash "$HERE/collect-errors.sh" start || exit 2
maestro test --exclude-tags destructive "${ARGS[@]}"
M=$?
bash "$HERE/collect-errors.sh" end
E=$?
AFTER="$(snap)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "run-maestro: WARNING phone accessibility settings changed during the run:"
  diff <(echo "$BEFORE") <(echo "$AFTER")
fi
echo "run-maestro: maestro=$M errors=$E"
[ $M -eq 0 ] && [ $E -eq 0 ]
