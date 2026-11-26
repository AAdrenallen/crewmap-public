package app.crewmap.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/** Receives Activity Recognition updates (periodic detections + transitions) and forwards them to JS. */
class ActivityReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (ActivityRecognitionResult.hasResult(intent)) {
      val r = ActivityRecognitionResult.extractResult(intent) ?: return
      val a = r.mostProbableActivity
      publish(context, nameOf(a.type), a.confidence, r.time)
    } else if (ActivityTransitionResult.hasResult(intent)) {
      val r = ActivityTransitionResult.extractResult(intent) ?: return
      for (e in r.transitionEvents) {
        if (e.transitionType == com.google.android.gms.location.ActivityTransition.ACTIVITY_TRANSITION_ENTER) {
          // elapsedRealtimeNanos → wall clock
          val wall = System.currentTimeMillis() - (android.os.SystemClock.elapsedRealtimeNanos() - e.elapsedRealTimeNanos) / 1_000_000
          publish(context, nameOf(e.activityType), 100, wall)
        }
      }
    }
  }

  private fun publish(ctx: Context, activity: String, confidence: Int, t: Long) {
    CrewmapBus.prefs(ctx).edit()
      .putString("lastActivity", activity)
      .putInt("lastActivityConfidence", confidence)
      .putLong("lastActivityAt", t)
      .apply()
    CrewmapBus.emit("onActivity", Bundle().apply {
      putString("activity", activity)
      putInt("confidence", confidence)
      putDouble("t", t.toDouble())
    })
  }

  companion object {
    fun nameOf(type: Int): String = when (type) {
      DetectedActivity.IN_VEHICLE -> "automotive"
      DetectedActivity.ON_BICYCLE -> "cycling"
      DetectedActivity.RUNNING -> "running"
      DetectedActivity.WALKING, DetectedActivity.ON_FOOT -> "walking"
      DetectedActivity.STILL -> "still"
      else -> "unknown"
    }
  }
}
