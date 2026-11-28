package app.crewmap.platform

import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Runs the JS task "CrewmapSync" headlessly for ≤ 25 s: catch up on circle messages, ack, post notifications. */
class CrewmapSyncTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    val args = Arguments.createMap().apply { putString("reason", intent?.getStringExtra("reason") ?: "push") }
    return HeadlessJsTaskConfig("CrewmapSync", args, 25_000, true)
  }

  companion object {
    fun start(ctx: Context, reason: String): Boolean = try {
      val i = Intent(ctx, CrewmapSyncTaskService::class.java).putExtra("reason", reason)
      ctx.startService(i)
      HeadlessJsTaskService.acquireWakeLockNow(ctx)
      true
    } catch (_: Throwable) {
      false
    }
  }
}
