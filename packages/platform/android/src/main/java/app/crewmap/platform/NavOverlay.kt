package app.crewmap.platform

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Floating CrewMap bubble drawn over Waze / Google Maps while they navigate. Process-scoped: the location foreground
 * service keeps the process alive while driving, so the overlay survives the app going to background. The window is
 * opaque (alpha 1) and only as large as its content, so Android 12+ untrusted-touch blocking never applies to the app
 * underneath. Collapsed = 56 dp round bubble (initials + badge); expanded = compact card. Tap toggles, drag moves (the
 * position is remembered), tapping the card body brings CrewMap to the front.
 */
internal object NavOverlay {
  private val main = Handler(Looper.getMainLooper())
  private var root: FrameLayout? = null
  private var expanded = false
  private var last: JSONObject? = null

  fun canDraw(ctx: Context) = Settings.canDrawOverlays(ctx)

  fun requestPermission(ctx: Context): Boolean {
    val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { ctx.startActivity(i) }.isSuccess
  }

  fun show(ctx: Context): Boolean {
    val app = ctx.applicationContext
    if (!canDraw(app)) return false
    main.post { attach(app) }
    return true
  }

  fun hide() {
    main.post { detach() }
  }

  fun update(json: String) {
    val s = runCatching { JSONObject(json) }.getOrNull() ?: return
    main.post {
      last = s
      render()
    }
  }

  private fun wm(ctx: Context) = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager

  private fun dp(ctx: Context, v: Float) =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).roundToInt()

  @SuppressLint("ClickableViewAccessibility")
  private fun attach(ctx: Context) {
    if (root != null) return
    val prefs = CrewmapBus.prefs(ctx)
    val p = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = prefs.getInt("overlayX", dp(ctx, 12f))
      y = prefs.getInt("overlayY", dp(ctx, 160f))
      alpha = 1f
    }
    val r = FrameLayout(ctx)
    val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var dragging = false
    r.setOnTouchListener { v, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = e.rawX
          downY = e.rawY
          startX = p.x
          startY = p.y
          dragging = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - downX
          val dy = e.rawY - downY
          if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
          if (dragging) {
            p.x = startX + dx.roundToInt()
            p.y = startY + dy.roundToInt()
            runCatching { wm(ctx).updateViewLayout(v, p) }
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          if (dragging) {
            prefs.edit().putInt("overlayX", p.x).putInt("overlayY", p.y).apply()
          } else if (expanded && e.y > dp(ctx, 38f)) {
            openApp(ctx)
          } else {
            expanded = !expanded
            render()
          }
          true
        }
        else -> false
      }
    }
    if (runCatching { wm(ctx).addView(r, p) }.isFailure) return
    root = r
    render()
  }

  private fun detach() {
    val r = root ?: return
    runCatching { wm(r.context).removeViewImmediate(r) }
    root = null
    expanded = false
  }

  private fun openApp(ctx: Context) {
    val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
    runCatching { ctx.startActivity(i) }
  }

  private fun parseColor(s: String?, fallback: Int) = runCatching { Color.parseColor(s) }.getOrDefault(fallback)

  private fun render() {
    val r = root ?: return
    val ctx = r.context
    val s = last ?: JSONObject()
    val me = s.optJSONObject("me")
    val meColor = parseColor(me?.optString("color"), Color.parseColor("#4F5BFF"))
    val friends = s.optJSONArray("friends")
    r.removeAllViews()
    if (!expanded) {
      r.addView(bubble(ctx, me?.optString("initials").orEmpty(), meColor, friends?.length() ?: 0))
      return
    }
    val card = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(ctx, 12f), dp(ctx, 10f), dp(ctx, 12f), dp(ctx, 12f))
      background = GradientDrawable().apply {
        setColor(Color.parseColor("#151B2B"))
        cornerRadius = dp(ctx, 18f).toFloat()
      }
      minimumWidth = dp(ctx, 200f)
    }
    val header = LinearLayout(ctx).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    header.addView(dot(ctx, meColor, 18f))
    val speed = s.optDouble("speedKmh", 0.0).roundToInt()
    header.addView(text(ctx, "$speed ${ctx.getString(R.string.crewmap_overlay_kmh)}", 15f, true).apply {
      setPadding(dp(ctx, 8f), 0, dp(ctx, 12f), 0)
    })
    if (s.has("score") && !s.isNull("score")) {
      header.addView(text(ctx, "${ctx.getString(R.string.crewmap_overlay_score)} ${s.optInt("score")}", 13f, false))
    }
    card.addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(ctx, 28f)))
    s.optJSONObject("nav")?.let { n ->
      val parts = listOfNotNull(
        if (n.isNull("remainingMin")) null else ctx.getString(R.string.crewmap_overlay_min, n.optInt("remainingMin")),
        if (n.isNull("arrival")) null else n.optString("arrival"),
      )
      if (parts.isNotEmpty()) card.addView(text(ctx, parts.joinToString(" · "), 14f, true).apply { setPadding(0, dp(ctx, 4f), 0, 0) })
      if (!n.isNull("nextInstruction")) {
        card.addView(text(ctx, n.optString("nextInstruction"), 13f, false).apply {
          setTextColor(Color.parseColor("#AEB6CC"))
          maxLines = 2
        })
      }
    }
    if (friends != null) {
      for (i in 0 until minOf(friends.length(), 5)) {
        val f = friends.optJSONObject(i) ?: continue
        val row = LinearLayout(ctx).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setPadding(0, dp(ctx, 6f), 0, 0)
        }
        row.addView(dot(ctx, parseColor(f.optString("color"), Color.GRAY), 10f))
        row.addView(
          text(ctx, f.optString("name"), 14f, false).apply {
            setPadding(dp(ctx, 8f), 0, dp(ctx, 12f), 0)
            maxLines = 1
          },
          LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        val eta = if (!f.has("etaMin") || f.isNull("etaMin")) "–" else ctx.getString(R.string.crewmap_overlay_min, f.optInt("etaMin"))
        row.addView(text(ctx, eta, 14f, true))
        card.addView(row)
      }
    }
    s.optJSONObject("lastEmote")?.let { e ->
      card.addView(text(ctx, "${e.optString("from")}: ${e.optString("label")}", 13f, false).apply {
        setTextColor(Color.parseColor("#FFC233"))
        setPadding(0, dp(ctx, 8f), 0, 0)
        maxLines = 1
      })
    }
    r.addView(card)
  }

  private fun bubble(ctx: Context, initials: String, color: Int, badge: Int): View {
    val size = dp(ctx, 56f)
    val f = FrameLayout(ctx)
    val circle = TextView(ctx).apply {
      text = initials.take(2).uppercase()
      gravity = Gravity.CENTER
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      typeface = Typeface.DEFAULT_BOLD
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
        setStroke(dp(ctx, 3f), Color.WHITE)
      }
    }
    f.addView(circle, FrameLayout.LayoutParams(size, size))
    if (badge > 0) {
      val b = TextView(ctx).apply {
        text = badge.toString()
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        typeface = Typeface.DEFAULT_BOLD
        background = GradientDrawable().apply {
          shape = GradientDrawable.OVAL
          setColor(Color.parseColor("#FF5A6A"))
        }
      }
      val bs = dp(ctx, 20f)
      f.addView(b, FrameLayout.LayoutParams(bs, bs, Gravity.TOP or Gravity.END))
    }
    return f
  }

  private fun dot(ctx: Context, color: Int, sizeDp: Float) = View(ctx).apply {
    background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(color)
    }
    layoutParams = LinearLayout.LayoutParams(dp(ctx, sizeDp), dp(ctx, sizeDp))
  }

  private fun text(ctx: Context, s: String, sp: Float, bold: Boolean) = TextView(ctx).apply {
    text = s
    setTextColor(Color.WHITE)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    if (bold) typeface = Typeface.DEFAULT_BOLD
  }
}
