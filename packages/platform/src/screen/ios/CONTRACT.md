# iOS: ScreenService
- **Native API:** `UIApplication.protectedDataDidBecomeAvailableNotification` (unlock), `…WillBecomeUnavailable` (lock), `UIScreen.brightness`/app state for interactivity.
- **Limits:** iOS gives no screen-on signal for other apps while backgrounded; phone handling is detected from unlock events and in-app touches only.
