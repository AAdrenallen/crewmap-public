import { create } from 'zustand';

/**
 * Map camera bearing, read only by the sprite markers (to pick a heading frame). Kept out of the app store and out
 * of CrewMapView state so a camera rotation never re-renders the map tree.
 */
export const useMapBearing = create<{ bearing: number }>(() => ({ bearing: 0 }));

/** Bearing change below which the shown sprite frame cannot change (16 frames = 22.5° each). */
export const BEARING_STEP_DEG = 6;

export function setMapBearing(deg: number): void {
  const cur = useMapBearing.getState().bearing;
  if (Math.abs(((deg - cur + 540) % 360) - 180) >= BEARING_STEP_DEG) useMapBearing.setState({ bearing: deg });
}
