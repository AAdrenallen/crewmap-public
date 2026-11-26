package app.crewmap.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a reboot or app update, run the sync task so JS can restart location sharing if it was on. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val sharing = CrewmapBus.prefs(context).getBoolean("sharingEnabled", false)
    if (sharing) CrewmapSyncTaskService.start(context, "boot")
  }
}
