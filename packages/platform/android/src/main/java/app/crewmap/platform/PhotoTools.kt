package app.crewmap.platform

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Trip memory photos (D68): re-encode a picked or captured image to a small JPEG (EXIF rotation applied, metadata such
 * as GPS dropped by the re-encode), and hand a generated recap card to the system share sheet via MediaStore.
 */
object PhotoTools {
  /** Returns { uri, width, height, bytes } of a JPEG in the cache dir, or null when the image cannot be read. */
  fun compress(ctx: Context, src: String, maxEdge: Int, maxBytes: Int): Map<String, Any>? {
    val uri = Uri.parse(src)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
    val decoded = ctx.contentResolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: return null
    val rotation = runCatching {
      ctx.contentResolver.openInputStream(uri)?.use {
        when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90f
          ExifInterface.ORIENTATION_ROTATE_180 -> 180f
          ExifInterface.ORIENTATION_ROTATE_270 -> 270f
          else -> 0f
        }
      } ?: 0f
    }.getOrDefault(0f)
    val scale = minOf(1f, maxEdge.toFloat() / max(decoded.width, decoded.height))
    val m = Matrix().apply {
      if (scale < 1f) postScale(scale, scale)
      if (rotation != 0f) postRotate(rotation)
    }
    val bmp = if (scale < 1f || rotation != 0f) Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, m, true) else decoded
    var quality = 82
    var out: ByteArray
    var current = bmp
    while (true) {
      val bos = ByteArrayOutputStream()
      current.compress(Bitmap.CompressFormat.JPEG, quality, bos)
      out = bos.toByteArray()
      if (out.size <= maxBytes) break
      if (quality > 50) {
        quality -= 8
      } else {
        // Still too big at a low quality: shrink by a quarter and try again.
        val w = (current.width * 0.75f).roundToInt()
        val h = (current.height * 0.75f).roundToInt()
        if (w < 64 || h < 64) return null
        current = Bitmap.createScaledBitmap(current, w, h, true)
        quality = 70
      }
    }
    val dir = File(ctx.cacheDir, "memory-photos").apply { mkdirs() }
    val f = File(dir, "p${System.currentTimeMillis()}.jpg")
    f.writeBytes(out)
    return mapOf("uri" to Uri.fromFile(f).toString(), "width" to current.width, "height" to current.height, "bytes" to out.size)
  }

  /** Copies a local image into Pictures/CrewMap and opens the share sheet for it. False before Android 10 or on failure. */
  fun share(ctx: Context, activity: Activity?, src: String, mime: String, title: String): Boolean {
    if (Build.VERSION.SDK_INT < 29) return false
    val path = Uri.parse(src).path ?: return false
    val bytes = runCatching { File(path).readBytes() }.getOrNull() ?: return false
    val ext = if (mime == "image/png") "png" else "jpg"
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, "crewmap-${System.currentTimeMillis()}.$ext")
      put(MediaStore.Images.Media.MIME_TYPE, mime)
      put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/CrewMap")
    }
    val resolver = ctx.contentResolver
    val item = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
    resolver.openOutputStream(item)?.use { it.write(bytes) } ?: return false
    val send = Intent(Intent.ACTION_SEND).apply {
      type = mime
      putExtra(Intent.EXTRA_STREAM, item)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, title).apply { if (activity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    return runCatching { (activity ?: ctx).startActivity(chooser) }.isSuccess
  }
}
