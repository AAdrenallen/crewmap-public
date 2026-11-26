import type { NavOverlayService } from '../contracts';
import { native } from '../native';

/** Floating CrewMap bubble drawn over Waze / Google Maps (Kotlin `NavOverlay`, TYPE_APPLICATION_OVERLAY). */
export const androidNavOverlay: NavOverlayService = {
  canDraw: () => native.overlayCanDraw(),
  requestPermission: () => native.overlayRequestPermission(),
  show: () => native.overlayShow(),
  hide: () => native.overlayHide(),
  update: (s) => native.overlayUpdate(JSON.stringify(s)),
};
