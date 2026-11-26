/** Pure geometry for the maneuver glyphs (no RN imports so it is unit-testable). Glyph space is 48x48 nominal. */
export const ANGLE: Record<string, number> = { 'sharp right': 135, right: 90, 'slight right': 45, straight: 0, 'slight left': -45, left: -90, 'sharp left': -135 };
/** Drawing viewBox: larger than the nominal 48 so arrowheads that overshoot it are never clipped. */
export const VIEWBOX = { x: -8, y: -8, w: 64, h: 64 };
export const STROKE = 5.5;

export type Pt = [number, number];
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Arrowhead triangle corners at (x, y) pointing along `deg` (0 = up, clockwise). */
export function headPts(x: number, y: number, deg: number, k = 1): Pt[] {
  const r = (deg * Math.PI) / 180;
  const f = (dx: number, dy: number): Pt => [x + k * (dx * Math.cos(r) - dy * Math.sin(r)), y + k * (dx * Math.sin(r) + dy * Math.cos(r))];
  return [f(0, -9), f(9, 3), f(-9, 3)];
}

function bounds(pts: Pt[], pad: number): Bounds {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
}

export function turnPts(a: number, ramp = false): Pt[] {
  const r = (a * Math.PI) / 180;
  const pts: Pt[] = [[24, 44], [24 + Math.sin(r) * 15, 24 - Math.cos(r) * 15], ...headPts(24 + Math.sin(r) * 18, 24 - Math.cos(r) * 18, a)];
  if (ramp && a !== 0) pts.push([24, 6]);
  return pts;
}

/** Extents of the drawn glyph (stroke included) for a maneuver kind. */
export function glyphBounds(kind: 'turn' | 'ramp' | 'uturn' | 'roundabout' | 'arrive', a = 0): Bounds {
  const pad = STROKE / 2;
  switch (kind) {
    case 'arrive':
      return { minX: 11, minY: 4, maxX: 37, maxY: 42 };
    case 'uturn':
      return bounds([[31, 44], [31, 13], [17, 13], [17, 34], ...headPts(17, 34, 180)], pad);
    case 'roundabout': {
      const r = (a * Math.PI) / 180;
      const c = bounds([[16, 14], [32, 30], [24, 44], ...headPts(24 + Math.sin(r) * 20, 22 - Math.cos(r) * 20, a)], pad);
      return c;
    }
    default:
      return bounds(turnPts(a, kind === 'ramp'), pad);
  }
}


/** Seconds to the turn at the current speed (m/s); null when effectively stopped. */
export function timeToTurnS(distM: number, speedMps: number | null | undefined): number | null {
  if (speedMps == null || !(speedMps >= 1.5) || !(distM >= 0)) return null;
  return Math.round(distM / speedMps);
}

/** Seconds -> value + unit for the info column: under 90 s in seconds, otherwise whole minutes. */
export function splitDuration(s: number): { n: number; unit: 'sec' | 'min' } {
  const v = Math.max(0, Math.round(s));
  return v < 90 ? { n: v, unit: 'sec' } : { n: Math.round(v / 60), unit: 'min' };
}

/** 0..1 fill of the approach bar: 0 when the step starts, 1 at the turn. `startM` is the farthest distance seen. */
export function approachProgress(distM: number, startM: number): number {
  if (!(startM > 0)) return 0;
  return Math.min(1, Math.max(0, 1 - distM / startM));
}
