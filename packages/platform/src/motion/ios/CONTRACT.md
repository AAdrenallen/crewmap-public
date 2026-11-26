# iOS: MotionService
- **Native API:** CoreMotion `CMMotionActivityManager.startActivityUpdates(to:)` (automotive, walking, running, cycling, stationary + confidence low/medium/high → 33/66/100), `CMMotionManager.deviceMotion.userAcceleration` (×9.81 → m/s²) for IMU.
- **Implementation:** add an iOS target to the Expo module in `packages/platform` (`ios/CrewmapPlatformModule.swift`) exposing `startActivityUpdates`, `getLastActivity`, `onActivity`. IMU uses `expo-sensors` (already cross-platform).
- **Limits:** activity updates are delivered only while the app runs (foreground or background location); `NSMotionUsageDescription` required (set). Confidence is coarse (3 levels).
