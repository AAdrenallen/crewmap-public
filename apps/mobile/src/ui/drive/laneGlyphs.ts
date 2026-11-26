/** Pure geometry for the lane strip: each lane is a mini road segment with every allowed movement drawn from one stem. */
import { ANGLE, headPts, type Pt } from './maneuverGeom';

/** Lane cell in glyph units (strip = count cells side by side). */
export const CELL = { w: 36, h: 52 } as const;
export const LANE_PAD = 2;
const SX = CELL.w / 2;
const STEM_BOTTOM = 42;
const BRANCH_Y = 27;
const HEAD_K = 0.62;
/** Minimum rendered stroke widths in px so arrows never get hairline thin at 6 lanes. */
export const MIN_STROKE_PX = { hot: 2.6, dim: 1.9, edge: 1 } as const;
export const BASE_STROKE = { hot: 4.2, dim: 3 } as const;

export type LaneArrow = { dir: string; hot: boolean; line: string; head: string; /** Lane-edge taper for merges (the lane narrows toward the merge side). */ taper?: string };
export type LaneShape = {
  /** Shared stem from the lane bottom up to the branch point (hot when this lane carries the route). */
  stem: string;
  stemHot: boolean;
  arrows: LaneArrow[];
  /** Turn-only lane (no through movement): drawn with a closing bar across the top. */
  turnOnly: boolean;
  /** Small chevron under the recommended lane. */
  yourLane: boolean;
  valid: boolean;
  /** Every point the shape draws (for bounds tests). */
  pts: Pt[];
};

const f = (n: number) => n.toFixed(2);
const headPath = (x: number, y: number, deg: number) => {
  const p = headPts(x, y, deg, HEAD_K);
  return { d: `M${f(p[0]![0])} ${f(p[0]![1])} L${f(p[1]![0])} ${f(p[1]![1])} L${f(p[2]![0])} ${f(p[2]![1])} Z`, pts: p };
};

type TurnShape = { line: string; head: string; taper?: string; pts: Pt[] };

/** Distinct silhouettes: slight = gentle S-bend, normal = 90 degree elbow, sharp = hook that doubles back, merge = slight bend + narrowing lane edge. */
export function turnShape(d: string): TurnShape {
  const merge = d === 'merge-left' || d === 'merge-right';
  const sgn = d.endsWith('left') ? -1 : 1;
  const cls = merge || d.startsWith('slight') ? 'slight' : d.startsWith('sharp') ? 'sharp' : 'normal';
  const x = (v: number) => f(SX + sgn * v);
  if (cls === 'slight') {
    const line = `M${SX} 36 C${SX} 30 ${x(7)} 31 ${x(7)} 23`;
    const h = headPath(SX + sgn * 7.6, 17.5, sgn * 20);
    const pts: Pt[] = [[SX, 36], [SX + sgn * 7, 23], ...h.pts];
    let taper: string | undefined;
    if (merge) {
      const edge = sgn < 0 ? 3 : CELL.w - 3;
      taper = `M${edge} 6 L${x(11)} 20`;
      pts.push([edge, 6], [SX + sgn * 11, 20]);
    }
    return { line, head: h.d, pts, ...(taper ? { taper } : {}) };
  }
  if (cls === 'normal') {
    const line = `M${SX} 36 V32 Q${SX} 27 ${x(5)} 27 H${x(7)}`;
    const h = headPath(SX + sgn * 10, 27, sgn * 90);
    return { line, head: h.d, pts: [[SX, 36], [SX + sgn * 7, 27], ...h.pts] };
  }
  const line = `M${SX} 36 V30 C${SX} 19 ${x(10)} 19 ${x(10)} 28`;
  const h = headPath(SX + sgn * 10, 31, sgn * 160);
  return { line, head: h.d, pts: [[SX, 36], [SX, 21], [SX + sgn * 10, 21], [SX + sgn * 10, 28], ...h.pts] };
}

export const INDICATION_ANGLE: Record<string, number> = { ...ANGLE };

/** Is this lane a turn-only pocket (turns, no straight/none)? */
export function isTurnOnly(directions: readonly string[]): boolean {
  return directions.length > 0 && directions.every((d) => d !== 'straight' && d !== 'none');
}

/** Geometry of one lane in cell space (origin top-left of the cell). `use` = indication to highlight. */
export function laneShape(lane: { directions: readonly string[]; valid: boolean; active: boolean }, use: string | null): LaneShape {
  const pts: Pt[] = [];
  const arrows: LaneArrow[] = [];
  const dirs = [...lane.directions].sort((a, b) => Number(a === use) - Number(b === use));
  const stemTop = BRANCH_Y;
  for (const d of dirs) {
    const hot = d === use;
    if (d === 'uturn') {
      const line = `M${f(SX + 4)} ${STEM_BOTTOM} V19 A5 5 0 0 0 ${f(SX - 6)} 19 V30`;
      const h = headPath(SX - 6, 32, 180);
      pts.push([SX + 4, STEM_BOTTOM], [SX + 4, 14], [SX - 6, 14], ...h.pts);
      arrows.push({ dir: d, hot, line, head: h.d });
    } else if (d === 'straight' || d === 'none') {
      const h = headPath(SX, 15, 0);
      pts.push([SX, STEM_BOTTOM], ...h.pts);
      arrows.push({ dir: d, hot, line: `M${SX} ${BRANCH_Y} V18`, head: h.d });
    } else {
      const g = turnShape(d);
      pts.push(...g.pts);
      arrows.push({ dir: d, hot, line: g.line, head: g.head, ...(g.taper ? { taper: g.taper } : {}) });
    }
  }
  pts.push([SX, STEM_BOTTOM]);
  const turnOnly = isTurnOnly(lane.directions);
  const yourLane = lane.valid && lane.active;
  if (yourLane) pts.push([SX - 5, 45], [SX + 5, 49]);
  if (turnOnly) pts.push([SX - 6, 5], [SX + 6, 5]);
  return {
    stem: `M${SX} ${STEM_BOTTOM} V${stemTop}`,
    stemHot: use !== null,
    arrows,
    turnOnly,
    yourLane,
    valid: lane.valid,
    pts,
  };
}

/** Dashed separator x positions (between lanes) and the solid road edges, in strip units. */
export function laneDividers(count: number): { dashed: number[]; edges: [number, number] } {
  const n = Math.max(1, Math.floor(count));
  return { dashed: Array.from({ length: n - 1 }, (_, i) => (i + 1) * CELL.w), edges: [0, n * CELL.w] };
}

export type StripLayout = { scale: number; width: number; height: number; units: { w: number; h: number } };

/** Fit `count` lane cells in a w x h box; scale is uniform so lanes stay centred with equal gaps. */
export function laneStripLayout(count: number, w: number, h: number, compact = false): StripLayout {
  const n = Math.max(1, Math.floor(count));
  const units = { w: n * CELL.w, h: CELL.h };
  const maxScale = compact ? 1.2 : 1.7;
  const scale = Math.max(0.2, Math.min(maxScale, Math.max(0, h) / units.h, Math.max(0, w) / units.w));
  return { scale, width: units.w * scale, height: units.h * scale, units };
}

/** Stroke width in glyph units so the rendered width never drops below the px minimum. */
export function strokeUnits(kind: 'hot' | 'dim' | 'edge', scale: number): number {
  const base = kind === 'edge' ? 1 : BASE_STROKE[kind];
  return Math.max(base, MIN_STROKE_PX[kind] / Math.max(scale, 0.01));
}
