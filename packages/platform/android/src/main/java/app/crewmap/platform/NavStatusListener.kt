package app.crewmap.platform

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Reads only the ongoing navigation notification of Waze / Google Maps and forwards its raw strings to JS, where
 * they are parsed (packages/shared/src/navigation/externalNavParse.ts). Every other notification is ignored on
 * arrival; nothing is stored or forwarded when the JS context is down (D25: privacy).
 */
class NavStatusListener : NotificationListenerService() {
  override fun onListenerConnected() {
    runCatching { activeNotifications?.forEach { onNotificationPosted(it) } }
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val app = appOf(sbn) ?: return
    val n = sbn.notification ?: return
    if (!isNavigation(n)) return
    val x = n.extras ?: return
    CrewmapBus.emit("onExternalNavRaw", Bundle().apply {
      putString("app", app)
      putString("title", x.getCharSequence(Notification.EXTRA_TITLE)?.toString())
      putString("text", x.getCharSequence(Notification.EXTRA_TEXT)?.toString())
      putString("subText", x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString())
      putString("bigText", x.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString())
      putDouble("t", System.currentTimeMillis().toDouble())
    })
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {
    val app = appOf(sbn) ?: return
    val n = sbn.notification ?: return
    if (!isNavigation(n)) return
    CrewmapBus.emit("onExternalNavEnded", Bundle().apply {
      putString("app", app)
      putDouble("t", System.currentTimeMillis().toDouble())
    })
  }

  private fun appOf(sbn: StatusBarNotification): String? = when (sbn.packageName) {
    "com.waze" -> "waze"
    "com.google.android.apps.maps" -> "gmaps"
    else -> null
  }

  /** Ongoing, and tagged as navigation when the app sets a category (both apps do on current versions). */
  private fun isNavigation(n: Notification): Boolean {
    if (n.flags and Notification.FLAG_ONGOING_EVENT == 0) return false
    val cat = n.category ?: return true
    return cat == Notification.CATEGORY_NAVIGATION || cat == Notification.CATEGORY_SERVICE || cat == Notification.CATEGORY_TRANSPORT
  }
}
