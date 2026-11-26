#!/usr/bin/env bash
# Background-power window for CrewMap WITHOUT unplugging the phone (charging stays on).
# Battery % doesn't move while charging, but batterystats still accounts the drivers of drain:
# GPS on-time, wake locks, mobile-radio active time, CPU time, alarms/jobs. Those are what we compare.
#
#   bash tools/device/battery-window.sh [minutes=20] [package=app.crewmap]
#
# Safety: any `dumpsys battery` override is reset on exit, error or Ctrl-C (owner rule: charging must never be left off).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/tools/env.sh" >/dev/null 2>&1
export MSYS_NO_PATHCONV=1
MIN="${1:-20}"
PKG="${2:-app.crewmap}"
OUT="$ROOT/.cache/battery-window-$(date +%Y%m%d-%H%M).txt"

restore() { adb shell dumpsys battery reset >/dev/null 2>&1 || true; }
trap restore EXIT INT TERM
restore

UID_NUM="$(adb shell dumpsys package "$PKG" | tr -d '\r' | grep -m1 -oE 'userId=[0-9]+' | cut -d= -f2)"
[ -n "$UID_NUM" ] || { echo "package $PKG not installed"; exit 1; }
UIDSTR="u0a$((UID_NUM - 10000))"

adb shell dumpsys batterystats --reset >/dev/null
echo "window: ${MIN} min, package $PKG ($UIDSTR); turn the screen off and leave the phone still"
adb shell input keyevent 26 >/dev/null 2>&1 || true
sleep "$((MIN * 60))"

adb shell dumpsys batterystats --charged "$PKG" > "$OUT" 2>/dev/null || adb shell dumpsys batterystats "$PKG" > "$OUT"
section() { grep -E "$1" "$OUT" | head -3 | sed 's/^ *//' | cut -c1-160; }
echo "gps:        $(section 'Sensor (GPS|-10000)|gps' | tr '\n' ' ')"
echo "wakelocks:  $(section 'Wake lock .*realtime|Total partial wakelock' | tr '\n' ' ')"
echo "radio:      $(section 'Mobile radio active|Wifi Running|Wifi scan' | tr '\n' ' ')"
echo "cpu:        $(section 'Total cpu time|cpu=' | tr '\n' ' ')"
echo "jobs/alarm: $(section 'Job |Wakeup alarm' | tr '\n' ' ')"
echo "location:   $(adb shell dumpsys location | tr -d '\r' | grep -iE "$PKG" | grep -iE 'Request|interval|priority' | head -3 | sed 's/^ *//' | cut -c1-140 | tr '\n' ' ')"
echo "full dump:  $OUT"
