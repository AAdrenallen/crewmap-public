# Dot-source from the repo root:  . .\tools\env.ps1
$root = Split-Path -Parent $PSScriptRoot
$env:JAVA_HOME = "$root\.tools\jdk17"
$env:ANDROID_HOME = "$root\.tools\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = "$root\.cache\gradle"
$env:npm_config_cache = "$root\.cache\npm"
$env:PNPM_HOME = "$root\.tools\pnpm"
$env:COREPACK_HOME = "$root\.cache\corepack"
$env:Path = "$root\.tools\node;$env:PNPM_HOME;$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\emulator;$root\.tools\blender;" + $env:Path
