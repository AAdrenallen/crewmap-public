import type { PhotoService } from '../contracts';
import { native } from '../native';

/** Kotlin `PhotoTools` (D68): BitmapFactory re-encode off the JS thread; MediaStore copy + ACTION_SEND chooser. */
export const androidPhotos: PhotoService = {
  compress: async (uri, maxEdge, maxBytes) => (await native.photoCompress(uri, Math.round(maxEdge), Math.round(maxBytes))) ?? null,
  share: (uri, mime, title) => native.photoShare(uri, mime, title),
};
