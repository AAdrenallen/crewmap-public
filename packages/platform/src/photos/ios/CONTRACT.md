# iOS: PhotoService (D68)
- **compress:** `UIImage(contentsOfFile:)` / `PHAsset` data → scale so the longest edge ≤ `maxEdge` → `jpegData(compressionQuality:)`, lowering quality (then size) until ≤ `maxBytes`; orientation baked in, EXIF/GPS dropped. Write to `NSTemporaryDirectory()` and return `file://` URI, width, height, bytes.
- **share:** `UIActivityViewController` with the file URL (saving to Photos is one of its actions; no photo-library permission needed for sharing).
