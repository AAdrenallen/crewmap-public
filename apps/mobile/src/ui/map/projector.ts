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

const stack: MapProjector[] = [];

/** Registers a map projector on top of the stack (so opening/closing /route never clobbers Home's projector). */
export function setProjector(p: MapProjector | null, prev?: MapProjector): void {
  if (p) {
    const idx = stack.indexOf(p);
    if (idx >= 0) stack.splice(idx, 1);
    stack.push(p);
  } else if (prev) {
    const idx = stack.lastIndexOf(prev);
    if (idx >= 0) stack.splice(idx, 1);
  } else {
    stack.pop();
  }
}

export function projector(): MapProjector | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}
