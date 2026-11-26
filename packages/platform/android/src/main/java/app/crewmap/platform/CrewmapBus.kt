package app.crewmap.platform

import android.content.Context
import android.os.Bundle
import java.lang.ref.WeakReference

/** Bridges Android receivers/services to the JS module when the React context is alive; persists otherwise. */
internal object CrewmapBus {
  private var module: WeakReference<CrewmapPlatformModule>? = null
  private const val PREFS = "crewmap_platform"

  fun attach(m: CrewmapPlatformModule) {
    module = WeakReference(m)
  }

  fun detach(m: CrewmapPlatformModule) {
    if (module?.get() === m) module = null
  }

  fun emit(event: String, body: Bundle): Boolean {
    val m = module?.get() ?: return false
    return try {
      m.emit(event, body)
      true
    } catch (_: Throwable) {
      false
    }
  }

  fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
