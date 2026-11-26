# iOS: ExternalNavService
- **Native API:** `UIApplication.canOpenURL` for `waze://` and `comgooglemaps://` (both listed in `LSApplicationQueriesSchemes`), then `UIApplication.open(url)`.
  Waze: `https://waze.com/ul?ll=LAT,LON&navigate=yes` (universal link). Google Maps: `comgooglemaps://?daddr=LAT,LON&directionsmode=driving`
  without vias, or the universal `https://www.google.com/maps/dir/?api=1&destination=…&waypoints=a|b&travelmode=driving&dir_action=navigate`
  with ≤ 3 shaping waypoints (URL builders shared with Android in `packages/shared/src/navigation/externalNav.ts`).
- **Limits:** Waze takes no waypoints, so its route can differ from the one chosen in CrewMap. Apple Maps is not offered.
