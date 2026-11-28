package app.crewmap.platform

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.SoundPool
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Polyphonic low-latency mixer for short emote voices and stings (<= 5 s).
 * Uses Android's native SoundPool (24 concurrent streams) so rapid/overlapping emotes sum additively in AudioFlinger
 * and genuinely grow louder and fuller together instead of pausing, ducking, or stealing MediaSession focus from each other.
 */
internal class EmoteSoundPool(private val ctx: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val pool: SoundPool = SoundPool.Builder()
    .setMaxStreams(24)
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build(),
    )
    .build()

  private val loaded = ConcurrentHashMap<String, Int>()
  private val ready = ConcurrentHashMap<Int, Boolean>()
  private val waiters = ConcurrentHashMap<Int, MutableList<(Boolean) -> Unit>>()
  private var focusReq: AudioFocusRequest? = null
  private var releaseRunnable: Runnable? = null

  init {
    pool.setOnLoadCompleteListener { _, sampleId, status ->
      val ok = status == 0
      if (ok) ready[sampleId] = true
      val list = waiters.remove(sampleId)
      list?.forEach { cb -> cb(ok) }
    }
  }

  private fun localPath(uri: String): String? {
    val clean = if (uri.startsWith("file://")) Uri.parse(uri).path else uri
    if (clean.isNullOrBlank()) return null
    val f = File(clean)
    return if (f.exists() && f.length() in 1..1_500_000) f.absolutePath else null
  }

  private fun duckExternalBriefly() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    main.post {
      if (focusReq == null) {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build(),
          )
          // Never pause or duck our own SoundPool streams when focus shifts.
          .setOnAudioFocusChangeListener { }
          .build()
        audio.requestAudioFocus(req)
        focusReq = req
      }
      releaseRunnable?.let { main.removeCallbacks(it) }
      val rel = Runnable {
        focusReq?.let { audio.abandonAudioFocusRequest(it) }
        focusReq = null
      }
      releaseRunnable = rel
      main.postDelayed(rel, 2600L)
    }
  }

  fun play(uri: String, volume: Float, rate: Float, duckUnderVoice: Boolean, done: (Boolean) -> Unit) {
    val path = localPath(uri) ?: return done(false)
    val v = volume.coerceIn(0.05f, 1.0f)
    val r = rate.coerceIn(0.5f, 2.0f)
    val startStream = { soundId: Int ->
      if (!duckUnderVoice) duckExternalBriefly()
      val streamId = pool.play(soundId, v, v, 1, 0, r)
      done(streamId != 0)
    }
    val existing = loaded[path]
    if (existing != null && ready[existing] == true) {
      startStream(existing)
      return
    }
    synchronized(this) {
      val id = loaded[path] ?: pool.load(path, 1).also {
        if (it == 0) return done(false)
        loaded[path] = it
      }
      if (ready[id] == true) {
        startStream(id)
      } else {
        waiters.getOrPut(id) { mutableListOf() }.add { ok ->
          if (ok) startStream(id) else done(false)
        }
      }
    }
  }

  fun release() {
    releaseRunnable?.let { main.removeCallbacks(it) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusReq?.let { runCatching { audio.abandonAudioFocusRequest(it) } }
    }
    focusReq = null
    loaded.clear()
    ready.clear()
    waiters.clear()
    runCatching { pool.release() }
  }
}
