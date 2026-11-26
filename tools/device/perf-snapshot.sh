#!/usr/bin/env bash
# Perf snapshot of app.crewmap on the USB phone: one compact line per metric.
# Usage: bash tools/device/perf-snapshot.sh [package] [activity]
# package: app.crewmap (APP_VARIANT=preview builds: app.crewmap.preview). The activity is resolved from the
# installed package's launcher (MainActivity in the generated AndroidManifest) unless given.
set -u
PKG="${1:-app.crewmap}"
A="adb shell"
ACT="${2:-$($A cmd package resolve-activity --brief "$PKG" 2>/dev/null | tr -d '' | tail -1)}"
case "$ACT" in */*) ;; *) ACT="$PKG/.MainActivity" ;; esac
$A am force-stop "$PKG" >/dev/null 2>&1
S=$($A am start -W -n "$ACT" 2>/dev/null | tr -d '\r')
echo "startup_ms total=$(echo "$S" | awk -F': ' '/TotalTime/{print $2}') wait=$(echo "$S" | awk -F': ' '/WaitTime/{print $2}')"
sleep 8
PID=$($A pidof "$PKG" | tr -d '\r')
[ -z "$PID" ] && { echo "error: $PKG not running"; exit 1; }
$A dumpsys gfxinfo "$PKG" reset >/dev/null 2>&1
M=$($A dumpsys meminfo "$PKG" | tr -d '\r')
echo "mem_kb $(echo "$M" | awk '/TOTAL PSS:/{print "pss="$3" rss="$6} /^ *TOTAL +[0-9]/&&!t{t=1;print "pss="$2}' | head -1) java=$(echo "$M" | awk '/Java Heap:/{print $3}') native=$(echo "$M" | awk '/Native Heap:/{print $3}') graphics=$(echo "$M" | awk '/Graphics:/{print $2}')"
echo "rss_kb $($A cat /proc/$PID/status | awk '/VmRSS/{print $2}' | tr -d '\r')"
echo "cpu_threads_top8 $($A top -H -b -n 1 -p "$PID" | tr -d '\r' | awk 'NR>7 && $9+0>0 {printf "%s=%s%% ", $NF, $9}' | cut -d' ' -f1-8)"
echo "cpu_proc $($A top -b -n 1 -p "$PID" | tr -d '\r' | awk -v p="$PID" '$1==p{print $9"%"}')"
echo "note interact with the map for ~10 s, then press Enter"; read -r _
G=$($A dumpsys gfxinfo "$PKG" | tr -d '\r')
echo "gfx frames=$(echo "$G" | awk -F': ' '/Total frames rendered/{print $2; exit}') janky=$(echo "$G" | awk -F': ' '/Janky frames:/{print $2; exit}') p90=$(echo "$G" | awk -F': ' '/90th percentile/{print $2; exit}') p99=$(echo "$G" | awk -F': ' '/99th percentile/{print $2; exit}')"
