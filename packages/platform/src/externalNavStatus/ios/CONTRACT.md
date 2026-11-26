# iOS: ExternalNavStatusService
- **Native API:** none. iOS has no notification-listener equivalent: an app cannot read another app's notifications,
  and Waze / Google Maps expose no navigation-status API or shared container to third parties.
- **Implementation:** `hasAccess()` → false, `requestAccess()` → false, `onUpdate` / `onEnded` register nothing and
  return a no-op unsubscribe. The Settings row is hidden on iOS.
- **Fallback:** while handed off, the published ETA stays CrewMap's own (routing ETA, or none when not navigating
  in-app); friends see no "via Waze/Google Maps" marker.
