package app.crewmap.platform

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.FileOutputStream

/** Players shown first in the picker (package-visibility `<queries>` in apps/mobile/plugins/withExternalNav.js). */
internal val KNOWN_PLAYERS = listOf(
  "com.spotify.music",
  "com.google.android.apps.youtube.music",
  "com.apple.android.music",
  "deezer.android.app",
  "com.amazon.mp3",
  "au.com.shiftyjelly.pocketcasts",
  "com.soundcloud.android",
  "com.aspiro.tidal",
  "com.qobuz.music",
  "com.maxmpz.audioplayer",
  "fm.player",
)

private val PLAYLIST_ACTION = Regex("playlist|radio|mix|station|next_list|skip_list", RegexOption.IGNORE_CASE)

/**
 * Now-playing bridge over the active media sessions. Allowed because CrewMap's NotificationListener holds
 * Notification Access. Track info only goes to the JS context on this device; nothing is logged or persisted except
 * the current cover in the app cache (privacy rule).
 */
internal class MediaBridge(private val ctx: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val msm = ctx.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
  private val listener = ComponentName(ctx, NavStatusListener::class.java)
  private var current: MediaController? = null
  private var lastKey: String? = null
  private var artKey: String? = null
  private var artUri: String? = null
  private var running = false

  private val sessionsChanged = MediaSessionManager.OnActiveSessionsChangedListener { pick(it ?: emptyList()) }
  private val cb = object : MediaController.Callback() {
    override fun onPlaybackStateChanged(state: PlaybackState?) = publish()
    override fun onMetadataChanged(metadata: MediaMetadata?) = publish()
    override fun onSessionDestroyed() = refresh()
  }

  fun hasAccess(): Boolean =
    androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

  private fun sessions(): List<MediaController> =
    if (!hasAccess()) emptyList() else runCatching { msm.getActiveSessions(listener) }.getOrDefault(emptyList())

  fun start() = main.post { startNow() }

  fun stop() = main.post { stopNow() }

  private fun startNow() {
    if (running || !hasAccess()) return
    running = runCatching { msm.addOnActiveSessionsChangedListener(sessionsChanged, listener, main) }.isSuccess
    refresh()
  }

  fun stopNow() {
    if (!running) return
    running = false
    runCatching { msm.removeOnActiveSessionsChangedListener(sessionsChanged) }
    current?.unregisterCallback(cb)
    current = null
    lastKey = null
  }

  fun refresh() = pick(sessions())

  /** The preferred app's session when it has one, else the playing one, else the most recent (system order). */
  private fun pick(list: List<MediaController>) {
    val pref = preferred()
    val next = list.firstOrNull { it.packageName == pref }
      ?: list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
      ?: list.firstOrNull()
    if (next?.sessionToken != current?.sessionToken) {
      current?.unregisterCallback(cb)
      current = next
      next?.registerCallback(cb, main)
    }
    publish()
  }

  fun snapshot(): Map<String, Any?>? {
    val c = current ?: sessions().firstOrNull() ?: return null
    val md = c.metadata
    val st = c.playbackState
    val playing = st?.state == PlaybackState.STATE_PLAYING || st?.state == PlaybackState.STATE_BUFFERING
    val acts = st?.actions ?: 0L
    val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
    val artist = md?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
    return mapOf(
      "pkg" to c.packageName,
      "app" to labelOf(c.packageName),
      "title" to title,
      "artist" to artist,
      "art" to art(c.packageName, title, artist, md),
      "playing" to playing,
      "canPrev" to (acts and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L),
      "canNext" to (acts and PlaybackState.ACTION_SKIP_TO_NEXT != 0L),
      "canNextPlaylist" to (playlistAction(st) != null),
    )
  }

  private fun publish() {
    if (!running) return
    val s = snapshot()
    val key = s?.let { "${it["pkg"]}|${it["title"]}|${it["artist"]}|${it["playing"]}|${it["canNext"]}|${it["canPrev"]}|${it["canNextPlaylist"]}" }
    if (key == lastKey) return
    lastKey = key
    CrewmapBus.emit("onMedia", Bundle().apply {
      if (s == null) {
        putBoolean("none", true)
        return@apply
      }
      putBoolean("none", false)
      putString("pkg", s["pkg"] as String)
      putString("app", s["app"] as String?)
      putString("title", s["title"] as String?)
      putString("artist", s["artist"] as String?)
      putString("art", s["art"] as String?)
      putBoolean("playing", s["playing"] as Boolean)
      putBoolean("canPrev", s["canPrev"] as Boolean)
      putBoolean("canNext", s["canNext"] as Boolean)
      putBoolean("canNextPlaylist", s["canNextPlaylist"] as Boolean)
    })
  }

  /** One cover file in the app cache, overwritten per track, downscaled to 160 px. */
  private fun art(pkg: String, title: String?, artist: String?, md: MediaMetadata?): String? {
    val key = "$pkg|$title|$artist"
    if (key == artKey) return artUri
    artKey = key
    val bmp = md?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md?.getBitmap(MediaMetadata.METADATA_KEY_ART)
    artUri = md?.getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI)?.takeIf { it.startsWith("http") || it.startsWith("file") }
    if (bmp != null) {
      artUri = runCatching {
        val scaled = Bitmap.createScaledBitmap(bmp, 160, (160f * bmp.height / bmp.width.coerceAtLeast(1)).toInt().coerceAtLeast(1), true)
        val f = File(ctx.cacheDir, "nowplaying-${key.hashCode().toUInt()}.jpg")
        ctx.cacheDir.listFiles { x -> x.name.startsWith("nowplaying-") && x != f }?.forEach { it.delete() }
        FileOutputStream(f).use { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        "file://${f.absolutePath}"
      }.getOrNull()
    }
    return artUri
  }

  private fun playlistAction(st: PlaybackState?): PlaybackState.CustomAction? =
    st?.customActions?.firstOrNull { PLAYLIST_ACTION.containsMatchIn(it.action) || PLAYLIST_ACTION.containsMatchIn(it.name ?: "") }

  /** Returns false when the session is gone or the action isn't exposed (the caller opens the app instead). */
  fun control(action: String): Boolean {
    val c = current ?: sessions().firstOrNull() ?: return false
    val t = c.transportControls
    val st = c.playbackState
    when (action) {
      "play" -> t.play()
      "pause" -> t.pause()
      "toggle" -> if (st?.state == PlaybackState.STATE_PLAYING) t.pause() else t.play()
      "next" -> t.skipToNext()
      "previous" -> t.skipToPrevious()
      "nextPlaylist" -> {
        val a = playlistAction(st) ?: return false
        t.sendCustomAction(a, a.extras)
      }
      else -> return false
    }
    return true
  }

  // --- Installed players + preference ------------------------------------------------------------------------------

  fun installed(): List<Map<String, String>> {
    val pm = ctx.packageManager
    val pkgs = LinkedHashSet<String>()
    KNOWN_PLAYERS.filter { pm.getLaunchIntentForPackage(it) != null }.forEach { pkgs.add(it) }
    runCatching {
      @Suppress("DEPRECATION")
      pm.queryIntentServices(Intent("android.media.browse.MediaBrowserService"), 0)
        .mapNotNull { it.serviceInfo?.packageName }
        .filter { it != ctx.packageName && pm.getLaunchIntentForPackage(it) != null }
        .forEach { pkgs.add(it) }
    }
    return pkgs.map { mapOf("pkg" to it, "label" to (labelOf(it) ?: it)) }
  }

  private fun labelOf(pkg: String): String? = runCatching {
    val pm = ctx.packageManager
    @Suppress("DEPRECATION")
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
  }.getOrNull()

  fun preferred(): String? = CrewmapBus.prefs(ctx).getString("mediaApp", null)

  fun setPreferred(pkg: String?) {
    CrewmapBus.prefs(ctx).edit().apply { if (pkg == null) remove("mediaApp") else putString("mediaApp", pkg) }.apply()
    refresh()
  }

  /** Preferred app, else the app of the most recent session, else the first installed player. */
  fun target(pkg: String?): String? = pkg ?: preferred() ?: current?.packageName ?: sessions().firstOrNull()?.packageName
    ?: installed().firstOrNull()?.get("pkg")

  // --- Split screen -------------------------------------------------------------------------------------------------

  /**
   * Opens the player in the adjacent multi-window pane (Android 7+). Resolves "split" when CrewMap ends up in
   * multi-window, "app" when the system opened it full screen instead (then the bubble is shown if permitted), "none"
   * when no player could be opened.
   */
  fun openSplit(activity: Activity?, pkg: String?, done: (String) -> Unit) = main.post { openSplitNow(activity, pkg, done) }

  private fun openSplitNow(activity: Activity?, pkg: String?, done: (String) -> Unit) {
    val p = target(pkg) ?: return done("none")
    val launch = ctx.packageManager.getLaunchIntentForPackage(p) ?: return done("none")
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)
    val ok = runCatching { (activity ?: ctx).startActivity(launch) }.isSuccess
    if (!ok) return done("none")
    if (activity == null) return done("app")
    main.postDelayed({
      if (activity.isInMultiWindowMode) {
        done("split")
      } else {
        if (NavOverlay.canDraw(ctx)) NavOverlay.show(ctx)
        done("app")
      }
    }, 900)
  }

}
