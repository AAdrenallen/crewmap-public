# Health data (deferred on both platforms)
- **Android:** Health Connect (`androidx.health.connect:connect-client`), records `ExerciseSessionRecord`, `DistanceRecord`, `StepsRecord`.
- **iOS:** HealthKit `HKWorkout`, `HKQuantityTypeIdentifier.distanceWalkingRunning`, `.stepCount`; entitlement + `NSHealthShareUsageDescription`.
- **Merge plan:** DECISIONS D15 (interval overlap ±2 min → app-tracked record wins).
