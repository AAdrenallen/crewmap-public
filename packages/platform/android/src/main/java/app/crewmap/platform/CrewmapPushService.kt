package app.crewmap.platform

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * UnifiedPush (ntfy) receiver. Pings are content-free "sync now" signals. If the app's JS is running, it is told to
 * catch up; otherwise a short headless sync task is started (the distributor's binding counts as foreground for
 * Android's background-start rules). If even that is refused, a content-free notification is shown.
 */
class CrewmapPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    CrewmapBus.prefs(this).edit().putString("pushEndpoint", endpoint.url).apply()
    CrewmapBus.emit("onPushEndpoint", Bundle().apply { putString("endpoint", endpoint.url) })
  }

  override fun onMessage(message: PushMessage, instance: String) {
    if (CrewmapBus.emit("onPushMessage", Bundle().apply { putDouble("t", System.currentTimeMillis().toDouble()) })) return
    if (!CrewmapSyncTaskService.start(this, "push")) notifyGeneric(this)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    CrewmapBus.prefs(this).edit().remove("pushEndpoint").apply()
    CrewmapBus.emit("onPushEndpoint", Bundle().apply { putString("endpoint", null) })
  }

  override fun onUnregistered(instance: String) {
    CrewmapBus.prefs(this).edit().remove("pushEndpoint").apply()
    CrewmapBus.emit("onPushEndpoint", Bundle().apply { putString("endpoint", null) })
  }

  companion object {
    private const val CHANNEL = "crewmap-activity"

    fun notifyGeneric(ctx: Context) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Circle activity", NotificationManager.IMPORTANCE_DEFAULT))
      }
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val pi = android.app.PendingIntent.getActivity(
        ctx, 0, launch, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
      )
      val n = NotificationCompat.Builder(ctx, CHANNEL)
        .setSmallIcon(ctx.applicationInfo.icon)
        .setContentTitle("CrewMap")
        .setContentText(ctx.getString(R.string.crewmap_generic_activity))
        .setContentIntent(pi)
        .setAutoCancel(true)
        .build()
      nm.notify(4201, n)
    }
  }
}
