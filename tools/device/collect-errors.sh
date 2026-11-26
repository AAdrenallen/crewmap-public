#!/usr/bin/env bash
# Device-run error collection (CI and local).
#   collect-errors.sh start   clear logcat and the app's on-device error log
#   collect-errors.sh end     dump the app log, grep logcat, write .cache/test-errors.txt; exit 1 when errors found
# Env: APP_ID (default app.crewmap), ADB (default adb), ANDROID_SERIAL (adb's own device selector).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_ID="${APP_ID:-app.crewmap}"
ADB="${ADB:-adb}"
OUT="$ROOT/.cache/test-errors.txt"
ALLOW="$ROOT/tools/device/error-allowlist.txt"
mkdir -p "$ROOT/.cache"

deeplink() { "$ADB" shell am start -W -a android.intent.action.VIEW -d "crewmap://dev/errors?action=$1" "$APP_ID" >/dev/null 2>&1; }

PATTERN='ReactNativeJS.*(Error|Exception|Warning: )|Render Error|Invariant Violation|Mapbox.*\[(error|warning)\]|^[EW]/[^(]*(Mapbox|RNMBX)|FATAL EXCEPTION|AndroidRuntime|ClassCastException|ANR in|CMERRLOG \{'

case "${1:-}" in
  start)
    "$ADB" logcat -c || { echo "collect-errors: adb logcat -c failed" >&2; exit 2; }
    # The app may still be loading its bundle (e.g. right after a relaunch): retry until a dump shows an empty log.
    for _ in 1 2 3 4 5; do
      deeplink clear
      sleep 2
      "$ADB" logcat -c
      deeplink dump
      sleep 2
      "$ADB" logcat -d -v brief 2>/dev/null | grep -q 'CMERRLOG count=0' && break
    done
    "$ADB" logcat -c
    echo "collect-errors: logcat cleared"
    ;;
  end)
    deeplink dump
    sleep 3
    RAW="$ROOT/.cache/test-logcat.txt"
    "$ADB" logcat -d -v brief > "$RAW" 2>/dev/null
    FILTER=(cat)
    if [ -f "$ALLOW" ]; then
      grep -Ev '^\s*(#|$)' "$ALLOW" > "$ROOT/.cache/test-allow.re" || true
      [ -s "$ROOT/.cache/test-allow.re" ] && FILTER=(grep -Ev -f "$ROOT/.cache/test-allow.re")
    fi
    # Only our app's process(es) plus the Mapbox/ReactNativeJS/RNMBX tags: system-process noise (other pids) is ignored.
    PIDS=$( { "$ADB" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r'; grep -E "Start proc [0-9]+:$APP_ID[/ ]" "$RAW" | sed -E 's/.*Start proc ([0-9]+):.*/\1/'; } | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u | paste -sd'|' -)
    OURS='^[A-Z]/(ReactNativeJS|Mapbox|RNMBX)'
    [ -n "$PIDS" ] && OURS="$OURS|\( *($PIDS)\):"
    grep -E "$PATTERN" "$RAW" | grep -E "$OURS" | "${FILTER[@]}" > "$OUT" || true
    N=$(wc -l < "$OUT" | tr -d ' ')
    if [ "$N" -gt 0 ]; then
      echo "collect-errors: $N error line(s) -> .cache/test-errors.txt" >&2
      head -20 "$OUT" >&2
      exit 1
    fi
    echo "collect-errors: no errors"
    ;;
  *)
    echo "usage: $0 start|end" >&2
    exit 2
    ;;
esac
