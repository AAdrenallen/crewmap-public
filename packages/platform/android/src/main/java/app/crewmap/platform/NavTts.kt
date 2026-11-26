package app.crewmap.platform

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Navigation voice on the system TextToSpeech engine (D-voice): one eagerly initialised engine, utterances queued
 * with QUEUE_ADD so mixed-language segments play back-to-back, a per-utterance offline voice per language, and
 * transient may-duck audio focus held for the whole queue.
 */
class NavTts(private val ctx: Context) {
  private val lock = Any()
  private var ready = false
  private var failed = false
  private val waiting = mutableListOf<() -> Unit>()
  /** Outstanding utterance ids → callback fired when that id finishes (only the last id of a batch has one). */
  private val outstanding = LinkedHashMap<String, (() -> Unit)?>()
  private val seq = AtomicLong()
  private val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val attrs = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  private var focus: AudioFocusRequest? = null

  private val tts: TextToSpeech = TextToSpeech(ctx) { status ->
    val cbs = synchronized(lock) {
      ready = status == TextToSpeech.SUCCESS
      failed = !ready
      waiting.toList().also { waiting.clear() }
    }
    cbs.forEach { it() }
  }

  init {
    tts.setAudioAttributes(attrs)
    tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) = Unit
      override fun onDone(utteranceId: String?) = finished(utteranceId)
      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) = finished(utteranceId)
      override fun onError(utteranceId: String?, errorCode: Int) = finished(utteranceId)
      override fun onStop(utteranceId: String?, interrupted: Boolean) = finished(utteranceId)
    })
  }

  private fun whenReady(fn: () -> Unit) {
    val now = synchronized(lock) {
      if (ready || failed) true else { waiting.add(fn); false }
    }
    if (now) fn()
  }

  private fun finished(id: String?) {
    if (id == null) return
    val (cb, empty) = synchronized(lock) {
      val cb = if (outstanding.containsKey(id)) outstanding.remove(id) else null
      cb to outstanding.isEmpty()
    }
    cb?.invoke()
    if (empty) releaseFocus()
  }

  private fun locale(lang: String): Locale = when (lang) {
    "fr" -> Locale("fr", "CA")
    "ru" -> Locale("ru", "RU")
    else -> Locale("en", "CA")
  }

  private fun installed(): List<Voice> =
    (runCatching { tts.voices }.getOrNull() ?: emptySet())
      .filter { !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }

  /** Gender hint from Google voice names ("en-us-x-tpf-local" → f); null when the name carries none. */
  private fun genderHint(v: Voice): Char? {
    val code = Regex("-x-([a-z]{3})").find(v.name)?.groupValues?.get(1) ?: return null
    return code.last().takeIf { it == 'f' || it == 'm' }
  }

  private fun isLocal(v: Voice) = !v.isNetworkConnectionRequired || v.name.endsWith("-local")

  /**
   * Specific installed voice for a language: Canadian locale first (en-CA / fr-CA, ru-RU), then the voice that best
   * matches `anchor` (same gender hint, same local/network tier, same family prefix), then quality, offline, latency.
   */
  private fun pick(lang: String, anchor: Voice?): Voice? {
    val want = locale(lang)
    val cands = installed().filter { it.locale.language == want.language }
    if (cands.isEmpty()) return null
    fun score(v: Voice): Int {
      var s = 0
      if (v.locale.country == want.country) s += 1000
      if (isLocal(v)) s += 200
      if (anchor != null) {
        if (genderHint(v) != null && genderHint(v) == genderHint(anchor)) s += 100
        if (isLocal(v) == isLocal(anchor)) s += 40
        if (v.quality == anchor.quality) s += 30
      }
      return s + v.quality / 10 - v.latency / 100
    }
    return cands.maxByOrNull(::score)
  }

  /** Voice used for `lang` in a single-voice utterance; English without en-CA is matched to the fr-CA speaker. */
  private fun voiceFor(lang: String): Voice? {
    val own = pick(lang, null)
    if (own != null && own.locale.country == locale(lang).country) return own
    val anchorLang = if (lang == "fr") "en" else "fr"
    val anchor = pick(anchorLang, null)?.takeIf { it.locale.country == "CA" }
    return pick(lang, anchor) ?: own
  }

  fun voiceName(lang: String, cb: (String?) -> Unit) = whenReady { cb(if (ready) voiceFor(lang)?.name else null) }

  fun voices(cb: (List<Map<String, Any>>) -> Unit) = whenReady {
    cb(
      if (!ready) emptyList()
      else installed().filter { it.locale.language in setOf("en", "fr", "ru") }.sortedBy { it.name }.map {
        mapOf("name" to it.name, "locale" to it.locale.toLanguageTag(), "quality" to it.quality, "network" to it.isNetworkConnectionRequired)
      },
    )
  }

  private fun acquireFocus() {
    if (focus != null) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
      audio.requestAudioFocus(req)
      focus = req
    }
  }

  private fun releaseFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focus?.let { audio.abandonAudioFocusRequest(it) }
    focus = null
  }

  /** Queue segments (lang, text); `done` fires when the last one finishes, fails or is stopped. */
  fun speak(segments: List<Pair<String, String>>, done: () -> Unit) {
    whenReady {
      val segs = segments.filter { it.second.isNotBlank() }
      if (!ready || segs.isEmpty()) { done(); return@whenReady }
      acquireFocus()
      val primary = voiceFor(segs[0].first)
      segs.forEachIndexed { i, (lang, text) ->
        val id = "nav-${seq.incrementAndGet()}"
        synchronized(lock) { outstanding[id] = if (i == segs.lastIndex) done else null }
        val v = if (lang == segs[0].first) primary else pick(lang, primary)
        if (v != null) tts.voice = v else tts.language = locale(lang)
        val params = Bundle()
        if (tts.speak(text, TextToSpeech.QUEUE_ADD, params, id) != TextToSpeech.SUCCESS) finished(id)
      }
    }
  }

  fun isSpeaking(): Boolean = synchronized(lock) { outstanding.isNotEmpty() }

  fun status(lang: String, cb: (String) -> Unit) {
    whenReady {
      if (!ready) { cb("missing"); return@whenReady }
      val avail = runCatching { tts.isLanguageAvailable(locale(lang)) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
      cb(if (avail >= TextToSpeech.LANG_AVAILABLE && voiceFor(lang) != null) "ok" else "missing")
    }
  }

  fun installVoice(): Boolean = runCatching {
    ctx.startActivity(Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }.isSuccess

  fun shutdown() {
    runCatching { tts.stop(); tts.shutdown() }
    releaseFocus()
  }
}
