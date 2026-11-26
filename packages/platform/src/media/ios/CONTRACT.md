# iOS: MediaService
- **Native API:** none for other apps. `MPNowPlayingInfoCenter` only publishes *our own* now-playing info; iOS gives no
  API to read or control another app's session (Spotify, Apple Music, …), and there is no split screen on iPhone.
- **Implementation:**
  - `hasAccess()` → false, `current()` → null, `onChange` never fires (returns a no-op unsubscribe), `control()` → false.
  - Apple Music only: `MPMusicPlayerController.systemMusicPlayer` (MediaPlayer, `NSAppleMusicUsageDescription`) can read
    the title/artist/artwork and play/pause/skip; if adopted, `current()`/`control()` cover `com.apple.android.music`'s
    iOS twin and nothing else.
  - `installed()` → apps from a fixed list whose URL scheme answers `canOpenURL` (`spotify:`, `youtubemusic:`, `music:`,
    `deezer:`, `pktc:`; schemes in `LSApplicationQueriesSchemes`). `preferred/setPreferred` persist in UserDefaults.
  - `openSplit(pkg?)` → opens the app with its URL scheme and resolves `'app'` (iPadOS Split View can't be triggered
    programmatically); CrewMap info then shows in the Live Activity (see navOverlay/ios/CONTRACT.md).
- **Privacy:** same rule as Android: track info is never logged, stored or sent off-device.
