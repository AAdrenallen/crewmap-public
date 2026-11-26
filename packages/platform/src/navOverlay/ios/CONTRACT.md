# iOS: NavOverlayService
- **Native API:** none. iOS does not let apps draw over other apps; there is no equivalent of `SYSTEM_ALERT_WINDOW`.
- **Implementation:** `canDraw()` → false, `requestPermission()` → false, `show/hide/update` are no-ops. While Waze/Google
  Maps navigates, CrewMap info reaches the user through a Live Activity (ActivityKit, Lock Screen + Dynamic Island) fed
  from the same `NavOverlaySnapshot` (friends' ETAs, last emote, speed, score), updated by the background location task.
- **Limits:** Live Activity updates from the app are throttled by the system; ETAs refresh at most every few seconds and
  tapping opens CrewMap (no in-place expand).
