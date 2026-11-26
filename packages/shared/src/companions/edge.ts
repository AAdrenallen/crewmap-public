import { normalizeDeg } from '../geo';

/** Screen rectangle in dp (left/top inclusive). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export type Edge = 'top' | 'right' | 'bottom' | 'left';

export type EdgePlacement =
  | { onScreen: true; x: number; y: number }
  | {
      onScreen: false;
      /** Centre of the blip, inside `safe` shrunk by `margin`. */
      x: number;
      y: number;
      edge: Edge;
      /** Arrow direction on screen: 0 = up, clockwise (deg). */
      angleDeg: number;
    };

/**
 * Where an indicator for a map target goes. `point` is the target projected to the screen (null / non-finite when the
 * projection failed, e.g. behind the horizon at high pitch); `relBearingDeg` is the bearing to the target relative to
 * the camera heading, used as the direction fallback. `safe` is the part of the screen kept free of banners, speed,
 * report button and the companion strip; a target inside it is on screen, otherwise the blip is clamped to its edge
 * along the ray from the safe centre to the target.
 */
export function edgePlacement(point: ScreenPoint | null, relBearingDeg: number, safe: Rect, margin = 22): EdgePlacement {
  const cx = (safe.left + safe.right) / 2;
  const cy = (safe.top + safe.bottom) / 2;
  const valid = !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
  if (valid && point.x >= safe.left && point.x <= safe.right && point.y >= safe.top && point.y <= safe.bottom) {
    return { onScreen: true, x: point.x, y: point.y };
  }
  let dx: number;
  let dy: number;
  if (valid && (point.x !== cx || point.y !== cy)) {
    dx = point.x - cx;
    dy = point.y - cy;
  } else {
    const r = (normalizeDeg(relBearingDeg) * Math.PI) / 180;
    dx = Math.sin(r);
    dy = -Math.cos(r);
  }
  const hw = Math.max(0, (safe.right - safe.left) / 2 - margin);
  const hh = Math.max(0, (safe.bottom - safe.top) / 2 - margin);
  // Scale the ray so it touches the inner box: the smaller of the two axis scales wins.
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const x = cx + dx * s;
  const y = cy + dy * s;
  const edge: Edge = sx <= sy ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  const angleDeg = normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
  return { onScreen: false, x, y, edge, angleDeg };
}

/**
 * The free part of the screen while driving: everything minus the reserved HUD rectangles. Each reserved rect only
 * trims the side it is docked to (a banner across the top lowers `top`, a strip on the right narrows `right`).
 */
export function safeRect(width: number, height: number, reserved: { top?: number; bottom?: number; left?: number; right?: number }): Rect {
  return {
    left: reserved.left ?? 0,
    top: reserved.top ?? 0,
    right: width - (reserved.right ?? 0),
    bottom: height - (reserved.bottom ?? 0),
  };
}

/** Blips that would overlap are spread along their edge (simple 1-D push, stable in input order). */
export function spreadBlips<T extends { x: number; y: number; edge: Edge }>(blips: T[], minGap = 40): T[] {
  const out = blips.map((b) => ({ ...b }));
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    const horiz = edge === 'top' || edge === 'bottom';
    const on = out.filter((b) => b.edge === edge).sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
    for (let i = 1; i < on.length; i++) {
      const prev = on[i - 1]!;
      const cur = on[i]!;
      if (horiz && cur.x - prev.x < minGap) cur.x = prev.x + minGap;
      if (!horiz && cur.y - prev.y < minGap) cur.y = prev.y + minGap;
    }
  }
  return out;
}
