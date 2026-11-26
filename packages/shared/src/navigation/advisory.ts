import { angleDiffDeg, bearingDeg, pointAlong, type LatLng } from '../geo';

/**
 * Advisory curve speeds (the yellow "curve + km/h" panels). No open feed publishes them, so they are derived from
 * route geometry: lateral acceleration a = v²/R, with a comfortable design value, rounded down to 10 km/h like the
 * signs. Turns at intersections (step maneuvers) are excluded; only bends of the road itself count.
 */
export const ADVISORY = {
  /** Comfortable lateral acceleration, m/s² (≈ 0.19 g; road design uses 0.15–0.20 g for advisory speeds). */
  lateralAccel: 1.9,
  /** Geometry sampling step, m. */
  sampleM: 10,
  /** Half chord used to measure curvature, m. */
  chordM: 30,
  /** Ignore bends within this distance of a maneuver point (intersection turns, ramps). */
  maneuverClearM: 60,
  /** Show only if the advisory is at least this much below the posted limit, km/h. */
  belowLimitKph: 10,
  /** Assumed limit when the route has none for the segment, km/h. */
  defaultLimitKph: 70,
  /** Minimum heading change of the whole bend, degrees (ignores small wiggles). */
  minTurnDeg: 30,
  minKph: 20,
  /** Show the panel this far before the bend, m. */
  lookaheadM: 450,
} as const;

export interface CurveAdvisory {
  startAlongM: number;
  endAlongM: number;
  speedKph: number;
  side: 'left' | 'right';
  /** Total heading change ≥ 80°: draw the sharp-curve glyph. */
  sharp: boolean;
}

interface RouteLike {
  geometry: LatLng[];
  cum: number[];
  maxspeedKph: (number | null)[];
  steps: { startAlongM: number }[];
}

function limitAt(r: RouteLike, along: number): number | null {
  let lo = 0;
  let hi = r.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid]! <= along) lo = mid;
    else hi = mid;
  }
  return r.maxspeedKph[lo] ?? null;
}

export function curveAdvisories(r: RouteLike, cfg = ADVISORY): CurveAdvisory[] {
  const total = r.cum[r.cum.length - 1] ?? 0;
  if (total < cfg.chordM * 3) return [];
  const maneuvers = r.steps.slice(1).map((s) => s.startAlongM);
  const out: CurveAdvisory[] = [];
  let zone: { start: number; end: number; minR: number; turn: number; limit: number } | null = null;
  const flush = () => {
    if (!zone) return;
    const z = zone;
    zone = null;
    // Whole-bend heading change: direction entering vs leaving the zone (robust to the zone's soft edges).
    const before = bearingDeg(pointAlong(r.geometry, r.cum, Math.max(0, z.start - cfg.chordM)), pointAlong(r.geometry, r.cum, Math.max(0, z.start)));
    const after = bearingDeg(pointAlong(r.geometry, r.cum, Math.min(total, z.end)), pointAlong(r.geometry, r.cum, Math.min(total, z.end + cfg.chordM)));
    z.turn = angleDiffDeg(before, after);
    if (Math.abs(z.turn) < cfg.minTurnDeg) return;
    const v = Math.floor((Math.sqrt(cfg.lateralAccel * z.minR) * 3.6) / 10) * 10;
    const speed = Math.max(cfg.minKph, v);
    if (speed > z.limit - cfg.belowLimitKph) return;
    out.push({ startAlongM: z.start, endAlongM: z.end, speedKph: speed, side: z.turn < 0 ? 'left' : 'right', sharp: Math.abs(z.turn) >= 80 });
  };
  for (let s = cfg.chordM; s <= total - cfg.chordM; s += cfg.sampleM) {
    const a = pointAlong(r.geometry, r.cum, s - cfg.chordM);
    const b = pointAlong(r.geometry, r.cum, s);
    const c = pointAlong(r.geometry, r.cum, s + cfg.chordM);
    const d = angleDiffDeg(bearingDeg(a, b), bearingDeg(b, c));
    const rad = (Math.abs(d) * Math.PI) / 180;
    const radius = rad > 1e-4 ? cfg.chordM / rad : Infinity;
    const limit = limitAt(r, s) ?? cfg.defaultLimitKph;
    const vKph = Math.sqrt(cfg.lateralAccel * radius) * 3.6;
    const nearManeuver = maneuvers.some((m) => Math.abs(m - s) < cfg.maneuverClearM);
    if (!nearManeuver && vKph < limit - cfg.belowLimitKph + 10) {
      if (!zone) zone = { start: s - cfg.chordM, end: s + cfg.chordM, minR: radius, turn: 0, limit };
      zone.end = s + cfg.chordM;
      zone.minR = Math.min(zone.minR, radius);
      zone.limit = Math.max(zone.limit, limit);
    } else flush();
  }
  flush();
  return out;
}

/** The advisory to show now: the next bend within the lookahead, kept until its end is passed. */
export function nextAdvisory(list: CurveAdvisory[], alongM: number, cfg = ADVISORY): CurveAdvisory | null {
  return list.find((a) => a.endAlongM > alongM && a.startAlongM - alongM <= cfg.lookaheadM) ?? null;
}
