package app.crewmap.platform

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.unifiedpush.android.connector.UnifiedPush

/**
 * CrewMap's Android platform adapter: Activity Recognition, screen state (phone-handling signal), battery
 * optimisation exemption + OEM info, UnifiedPush registration, and the sharing flag used after reboot.
 */
private val EXTERNAL_NAV_PACKAGES = listOf("waze" to "com.waze", "gmaps" to "com.google.android.apps.maps")

class CrewmapPlatformModule : Module() {
  private val ctx: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("no context")

  private var screenReceiver: BroadcastReceiver? = null
  private var navTts: NavTts? = null
  private fun tts(): NavTts = navTts ?: NavTts(ctx).also { navTts = it }
  private var mediaBridge: MediaBridge? = null
  private fun media(): MediaBridge = mediaBridge ?: MediaBridge(ctx).also { mediaBridge = it }

  fun emit(event: String, body: Bundle) = sendEvent(event, body)

  override fun definition() = ModuleDefinition {
    Name("CrewmapPlatform")
    Events("onActivity", "onScreen", "onPushEndpoint", "onPushMessage", "onExternalNavRaw", "onExternalNavEnded", "onMedia")

    OnCreate {
      CrewmapBus.attach(this@CrewmapPlatformModule)
      registerScreenReceiver()
      runCatching { tts() } // eager init: engine bind takes longer than the 300 ms speech budget
    }

    OnDestroy {
      CrewmapBus.detach(this@CrewmapPlatformModule)
      screenReceiver?.let { runCatching { ctx.unregisterReceiver(it) } }
      screenReceiver = null
      navTts?.shutdown()
      navTts = null
      mediaBridge?.stopNow()
      mediaBridge = null
    }

    // --- Navigation voice (system TextToSpeech) ---------------------------------------------------------------

    AsyncFunction("ttsSpeak") { segments: List<Map<String, String>>, promise: Promise ->
      tts().speak(segments.map { (it["lang"] ?: "en") to (it["text"] ?: "") }) { promise.resolve(true) }
    }

    Function("ttsIsSpeaking") { navTts?.isSpeaking() ?: false }

    AsyncFunction("ttsVoiceStatus") { lang: String, promise: Promise -> tts().status(lang) { promise.resolve(it) } }

    Function("ttsInstallVoice") { tts().installVoice() }

    AsyncFunction("ttsVoiceName") { lang: String, promise: Promise -> tts().voiceName(lang) { promise.resolve(it) } }

    AsyncFunction("ttsVoices") { promise: Promise -> tts().voices { promise.resolve(it) } }

    // --- Activity recognition -----------------------------------------------------------------------------------

    AsyncFunction("startActivityUpdates") { intervalMs: Double, promise: Promise ->
      try {
        val client = ActivityRecognition.getClient(ctx)
        val pi = activityPendingIntent()
        val transitions = listOf(
          DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE, DetectedActivity.WALKING,
          DetectedActivity.RUNNING, DetectedActivity.STILL,
        ).flatMap { type ->
          listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map {
            ActivityTransition.Builder().setActivityType(type).setActivityTransition(it).build()
          }
        }
        @SuppressLint("MissingPermission")
        fun go() {
          client.requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pi)
          client.requestActivityUpdates(intervalMs.toLong(), pi)
            .addOnSuccessListener { promise.resolve(true) }
            .addOnFailureListener { e -> promise.reject("E_ACTIVITY", e.message, e) }
        }
        go()
      } catch (e: SecurityException) {
        promise.reject("E_PERMISSION", "ACTIVITY_RECOGNITION not granted", e)
      }
    }

    AsyncFunction("stopActivityUpdates") { promise: Promise ->
      try {
        val client = ActivityRecognition.getClient(ctx)
        val pi = activityPendingIntent()
        @SuppressLint("MissingPermission")
        fun go() {
          client.removeActivityTransitionUpdates(pi)
          client.removeActivityUpdates(pi).addOnCompleteListener { promise.resolve(true) }
        }
        go()
      } catch (e: SecurityException) {
        promise.resolve(false)
      }
    }

    Function("getLastActivity") {
      val p = CrewmapBus.prefs(ctx)
      val a = p.getString("lastActivity", null) ?: return@Function null
      mapOf("activity" to a, "confidence" to p.getInt("lastActivityConfidence", 0), "t" to p.getLong("lastActivityAt", 0).toDouble())
    }

    // --- Screen state ---------------------------------------------------------------------------------------------

    Function("getScreenState") {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager
      mapOf("interactive" to pm.isInteractive, "locked" to km.isKeyguardLocked)
    }

    // --- Battery optimisation ----------------------------------------------------------------------------------------

    Function("isIgnoringBatteryOptimizations") {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    Function("requestIgnoreBatteryOptimizations") {
      @SuppressLint("BatteryLife")
      val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { (appContext.currentActivity ?: ctx).startActivity(i) }.isSuccess
    }

    Function("openAppBatterySettings") {
      val candidates = oemBatteryIntents() + Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
      for (i in candidates) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (i.resolveActivity(ctx.packageManager) != null && runCatching { ctx.startActivity(i) }.isSuccess) return@Function true
      }
      false
    }

    Function("deviceInfo") {
      mapOf(
        "manufacturer" to Build.MANUFACTURER.lowercase(),
        "brand" to Build.BRAND.lowercase(),
        "model" to Build.MODEL,
        "sdk" to Build.VERSION.SDK_INT,
        "release" to Build.VERSION.RELEASE,
      )
    }

    // --- UnifiedPush ------------------------------------------------------------------------------------------------

    Function("getPushEndpoint") { CrewmapBus.prefs(ctx).getString("pushEndpoint", null) }

    Function("getPushDistributors") { UnifiedPush.getDistributors(ctx) }

    AsyncFunction("registerPush") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok ->
        if (ok) UnifiedPush.register(ctx, messageForDistributor = "CrewMap")
        promise.resolve(ok)
      }
    }

    Function("unregisterPush") {
      UnifiedPush.unregister(ctx)
      CrewmapBus.prefs(ctx).edit().remove("pushEndpoint").apply()
    }

    // --- Sharing flag (for restart after reboot) --------------------------------------------------------------------

    // --- External navigation handoff ------------------------------------------------------------------------------

    Function("externalNavAvailable") {
      EXTERNAL_NAV_PACKAGES.filter { (_, pkg) -> isInstalled(pkg) }.map { it.first }
    }

    Function("externalNavLaunch") { app: String, url: String ->
      val pkg = EXTERNAL_NAV_PACKAGES.firstOrNull { it.first == app }?.second ?: return@Function false
      val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { (appContext.currentActivity ?: ctx).startActivity(i) }.isSuccess
    }

    // --- Floating overlay -----------------------------------------------------------------------------------------

    Function("overlayCanDraw") { NavOverlay.canDraw(ctx) }
    Function("overlayRequestPermission") { NavOverlay.requestPermission(ctx) }
    Function("overlayShow") { NavOverlay.show(ctx) }
    Function("overlayHide") { NavOverlay.hide() }
    Function("overlayUpdate") { json: String -> NavOverlay.update(json) }

    // --- Waze / Google Maps navigation status (Notification Access) ---------------------------------------------

    Function("navStatusHasAccess") {
      androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
    }
    Function("navStatusRequestAccess") {
      runCatching {
        ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      }.getOrDefault(false)
    }

    // --- Now playing (media sessions, via Notification Access) -----------------------------------------------------

    Function("mediaHasAccess") { media().hasAccess() }
    Function("mediaInstalled") { media().installed() }
    Function("mediaPreferred") { media().preferred() }
    Function("mediaSetPreferred") { pkg: String? -> media().setPreferred(pkg) }
    Function("mediaStart") { media().start() }
    Function("mediaStop") { media().stop() }
    Function("mediaCurrent") { media().snapshot() }
    Function("mediaControl") { action: String -> media().control(action) }
    AsyncFunction("mediaOpenSplit") { pkg: String?, promise: Promise ->
      media().openSplit(appContext.currentActivity, pkg) { promise.resolve(it) }
    }

    Function("setSharingEnabled") { on: Boolean -> CrewmapBus.prefs(ctx).edit().putBoolean("sharingEnabled", on).apply() }
  }

  private fun isInstalled(pkg: String): Boolean = runCatching {
    if (Build.VERSION.SDK_INT >= 33) {
      ctx.packageManager.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      ctx.packageManager.getPackageInfo(pkg, 0)
    }
  }.isSuccess

  private fun activityPendingIntent(): PendingIntent {
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    return PendingIntent.getBroadcast(ctx, 7, Intent(ctx, ActivityReceiver::class.java), flags)
  }

  private fun registerScreenReceiver() {
    if (screenReceiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context, i: Intent) {
        val kind = when (i.action) {
          Intent.ACTION_SCREEN_ON -> "screenOn"
          Intent.ACTION_SCREEN_OFF -> "screenOff"
          Intent.ACTION_USER_PRESENT -> "unlocked"
          else -> return
        }
        CrewmapBus.emit("onScreen", Bundle().apply {
          putString("kind", kind)
          putDouble("t", System.currentTimeMillis().toDouble())
        })
      }
    }
    val f = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_USER_PRESENT)
    }
    ContextCompat.registerReceiver(ctx, r, f, ContextCompat.RECEIVER_NOT_EXPORTED)
    screenReceiver = r
  }

  /** Known OEM "auto-start / background" screens (dontkillmyapp.com). Tried in order; the app details page is the fallback. */
  private fun oemBatteryIntents(): List<Intent> = when (Build.MANUFACTURER.lowercase()) {
    "oneplus" -> listOf(
      Intent().setComponent(ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")),
      Intent().setComponent(ComponentName("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity")),
    )
    "xiaomi", "redmi", "poco" -> listOf(
      Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")),
    )
    "samsung" -> listOf(
      Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity")),
    )
    "huawei", "honor" -> listOf(
      Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
    )
    "oppo", "realme" -> listOf(
      Intent().setComponent(ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")),
    )
    "vivo" -> listOf(
      Intent().setComponent(ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")),
    )
    else -> emptyList()
  }
}
