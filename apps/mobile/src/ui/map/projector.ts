/**
 * Bridge from overlays to the map camera without re-rendering the map tree (D28, D31): CrewMapView registers these
 * once; the companion overlay calls them at ≤ 4 Hz.
 */
export interface MapProjector {
  /** Screen point (dp) of a coordinate. */
  pointInView(lng: number, lat: number): Promise<[number, number]>;
  /** Briefly frame both points, then return to follow mode. */
  showBoth(a: { lat: number; lng: number }, b: { lat: number; lng: number }): void;
}

let current: MapProjector | null = null;

export function setProjector(p: MapProjector | null): void {
  current = p;
}

export function projector(): MapProjector | null {
  return current;
}
