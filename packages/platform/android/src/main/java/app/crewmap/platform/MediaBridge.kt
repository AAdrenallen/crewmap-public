package app.crewmap.platform

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.browse.MediaBrowser
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

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
  private val io = Executors.newSingleThreadExecutor()
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

  /** One cover file in the app cache, overwritten per track, downscaled to 160 px off the UI thread. */
  private fun art(pkg: String, title: String?, artist: String?, md: MediaMetadata?): String? {
    val key = "$pkg|$title|$artist"
    if (key == artKey) return artUri
    artKey = key
    val bmp = md?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md?.getBitmap(MediaMetadata.METADATA_KEY_ART)
    artUri = md?.getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI)?.takeIf { it.startsWith("http") || it.startsWith("file") }
    if (bmp != null) {
      val copy = runCatching { bmp.copy(Bitmap.Config.ARGB_8888, false) }.getOrNull() ?: return artUri
      io.execute {
        val uri = runCatching {
          val scaled = Bitmap.createScaledBitmap(copy, 160, (160f * copy.height / copy.width.coerceAtLeast(1)).toInt().coerceAtLeast(1), true)
          try {
            val f = File(ctx.cacheDir, "nowplaying-${key.hashCode().toUInt()}.jpg")
            ctx.cacheDir.listFiles { x -> x.name.startsWith("nowplaying-") && x != f }?.forEach { it.delete() }
            FileOutputStream(f).use { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            "file://${f.absolutePath}"
          } finally {
            if (scaled !== copy) scaled.recycle()
          }
        }.getOrNull()
        copy.recycle()
        if (uri != null) {
          main.post {
            if (artKey == key && artUri != uri) {
              artUri = uri
              lastKey = null
              publish()
            }
          }
        }
      }
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

  // --- In-app playlist / library / queue browsing -------------------------------------------------------------------

  private fun controllerFor(pkg: String?): MediaController? {
    val list = sessions()
    if (pkg != null) list.firstOrNull { it.packageName == pkg }?.let { return it }
    return current ?: list.firstOrNull()
  }

  /**
   * Returns browsable playlists/folders (via Android MediaBrowserService when exposed by the player) plus the active
   * session's Up Next queue items so CrewMap renders an integrated in-app player & playlist scroller.
   */
  fun browse(pkg: String?, parentId: String?, done: (List<Map<String, Any?>>) -> Unit) = main.post {
    val p = target(pkg) ?: return@post done(emptyList())
    val out = ArrayList<Map<String, Any?>>()
    if (parentId == null) {
      val ctrl = controllerFor(p)
      ctrl?.queue?.take(30)?.forEach { q ->
        val d = q.description
        val title = d.title?.toString()?.trim()
        if (!title.isNullOrEmpty()) {
          out.add(
            mapOf(
              "id" to q.queueId.toString(),
              "title" to title,
              "subtitle" to d.subtitle?.toString(),
              "art" to d.iconUri?.toString()?.takeIf { it.startsWith("http") || it.startsWith("content") || it.startsWith("file") },
              "kind" to "queue",
              "browsable" to false,
            ),
          )
        }
      }
    }
    @Suppress("DEPRECATION")
    val svc = runCatching {
      ctx.packageManager.queryIntentServices(Intent("android.media.browse.MediaBrowserService").setPackage(p), 0).firstOrNull()?.serviceInfo
    }.getOrNull()
    if (svc == null) return@post done(out)

    var finished = false
    var browser: MediaBrowser? = null
    val finish = { items: List<Map<String, Any?>> ->
      if (!finished) {
        finished = true
        runCatching { browser?.disconnect() }
        done(items + out)
      }
    }
    val timeout = Runnable { finish(emptyList()) }
    main.postDelayed(timeout, 1800L)

    val conn = object : MediaBrowser.ConnectionCallback() {
      override fun onConnected() {
        val b = browser ?: return finish(emptyList())
        val targetParent = parentId ?: runCatching { b.root }.getOrNull()
        if (targetParent.isNullOrEmpty()) return finish(emptyList())
        b.subscribe(
          targetParent,
          object : MediaBrowser.SubscriptionCallback() {
            override fun onChildrenLoaded(pid: String, children: MutableList<MediaBrowser.MediaItem>) {
              main.removeCallbacks(timeout)
              val mapped = children.take(40).mapNotNull { item ->
                val d = item.description
                val id = d.mediaId ?: return@mapNotNull null
                val title = d.title?.toString()?.trim() ?: return@mapNotNull null
                mapOf(
                  "id" to id,
                  "title" to title,
                  "subtitle" to d.subtitle?.toString(),
                  "art" to d.iconUri?.toString()?.takeIf { it.startsWith("http") || it.startsWith("content") || it.startsWith("file") },
                  "kind" to if (item.isBrowsable) "folder" else "media",
                  "browsable" to item.isBrowsable,
                )
              }
              finish(mapped)
            }

            override fun onError(pid: String) {
              main.removeCallbacks(timeout)
              finish(emptyList())
            }
          },
        )
      }

      override fun onConnectionFailed() {
        main.removeCallbacks(timeout)
        finish(emptyList())
      }

      override fun onConnectionSuspended() {
        main.removeCallbacks(timeout)
        finish(emptyList())
      }
    }
    browser = runCatching { MediaBrowser(ctx, ComponentName(svc.packageName, svc.name), conn, null) }.getOrNull()
    if (browser == null) {
      main.removeCallbacks(timeout)
      finish(emptyList())
    } else {
      runCatching { browser.connect() }.onFailure {
        main.removeCallbacks(timeout)
        finish(emptyList())
      }
    }
  }

  /** Plays a queue track, MediaBrowser playlist/track, search query, or opens the external player cleanly (never 50/50 split). */
  fun playItem(activity: Activity?, pkg: String?, kind: String, id: String): Boolean {
    val p = target(pkg) ?: return false
    if (kind == "open") {
      val launch = ctx.packageManager.getLaunchIntentForPackage(p)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return false
      return runCatching { (activity ?: ctx).startActivity(launch) }.isSuccess
    }
    val ctrl = controllerFor(p)
    if (ctrl != null) {
      val tc = ctrl.transportControls
      when (kind) {
        "queue" -> {
          val qid = id.toLongOrNull() ?: return false
          tc.skipToQueueItem(qid)
          return true
        }
        "media" -> {
          tc.playFromMediaId(id, null)
          return true
        }
        "search" -> {
          tc.playFromSearch(id, Bundle())
          return true
        }
      }
    }
    // If the player session isn't started yet and the user tapped a playlist/mix, fire MEDIA_PLAY_FROM_SEARCH without leaving CrewMap if possible, else launch player.
    if (kind == "search") {
      val searchIntent = Intent("android.media.action.MEDIA_PLAY_FROM_SEARCH")
        .setPackage(p)
        .putExtra(android.app.SearchManager.QUERY, id)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      if (searchIntent.resolveActivity(ctx.packageManager) != null && runCatching { (activity ?: ctx).startActivity(searchIntent) }.isSuccess) {
        return true
      }
    }
    return false
  }

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
