# Source from the repo root (Git Bash / CI):  source tools/env.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -d "$ROOT/.tools/node" ]; then
  # Windows tools (Gradle, Node) need Windows paths; keep PATH in POSIX form.
  WROOT="$ROOT"; command -v cygpath >/dev/null 2>&1 && WROOT="$(cygpath -m "$ROOT")"
  export JAVA_HOME="$WROOT/.tools/jdk17"
  export ANDROID_HOME="$WROOT/.tools/android-sdk"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export GRADLE_USER_HOME="$WROOT/.cache/gradle"
  export npm_config_cache="$ROOT/.cache/npm"
  export PNPM_HOME="$ROOT/.tools/pnpm"
  export COREPACK_HOME="$ROOT/.cache/corepack"
  # scrcpy (screen/audio capture) uses our adb via $ADB; its bundled adb is removed to avoid a second adb server.
  export ADB="$ROOT/.tools/android-sdk/platform-tools/adb.exe"
  export PATH="$ROOT/.tools/maestro/bin:$ROOT/.tools/scrcpy:$ROOT/.tools/node:$PNPM_HOME:$ROOT/.tools/jdk17/bin:$ROOT/.tools/android-sdk/platform-tools:$ROOT/.tools/android-sdk/cmdline-tools/latest/bin:$ROOT/.tools/android-sdk/emulator:$ROOT/.tools/blender:$PATH"
fi
