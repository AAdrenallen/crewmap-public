# iOS: PowerService
- **Native API:** no battery-optimisation exemption exists on iOS: `isIgnoringBatteryOptimizations` → true, `request…`/`openOem…` open the app's Settings page (`UIApplication.openSettingsURLString`). Battery via `expo-battery`, network via `expo-network` (both cross-platform). `deviceInfo` via `UIDevice`.
- **Limits:** Low Power Mode reduces background refresh; surface it in onboarding.
