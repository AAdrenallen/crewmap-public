#!/usr/bin/env bash
# Dev loop on Windows: restart Metro with a clean cache (its file watcher misses changes in the Hermes-bytecode
# graph here), then relaunch the dev client on the USB phone.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tools/env.sh"
powershell -NoProfile -Command "\$p=(Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique; foreach(\$id in \$p){ if((Get-Process -Id \$id).ProcessName -eq 'node'){ Stop-Process -Id \$id -Force } }" || true
cd "$ROOT/apps/mobile"
unset CI
EXPO_NO_TELEMETRY=1 nohup npx expo start --dev-client --port 8081 --clear < /dev/null > "$ROOT/.cache/metro.log" 2>&1 &
for i in $(seq 1 90); do curl -s -m 2 http://localhost:8081/status | grep -q running && break; sleep 2; done
adb reverse tcp:8081 tcp:8081 > /dev/null
adb shell am force-stop app.crewmap
adb logcat -c
adb shell am start -a android.intent.action.VIEW -d "exp+crewmap://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" app.crewmap > /dev/null
for i in $(seq 1 120); do adb logcat -d | grep -q 'Running "main"' && break; sleep 2; done
echo "relaunched"
