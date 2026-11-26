# iOS: GeofenceService
- **Native API:** `CLLocationManager.startMonitoring(for: CLCircularRegion)` via `expo-location` geofencing (cross-platform).
- **Limits:** max **20** regions per app (Android: 100) — keep the 20 nearest and re-register on significant movement; minimum effective radius ~100 m; events may be delayed by minutes; requires Always permission.
