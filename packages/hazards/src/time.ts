/**
 * America/Toronto (Québec) wall-clock ↔ UTC without Intl (Hermes-safe and deterministic in tests).
 * DST: second Sunday of March 02:00 local → first Sunday of November 02:00 local (US/Canada rule since 2007).
 */
function nthSunday(year: number, month0: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

/** DST start/end instants (UTC ms) for a year. */
function dstWindow(year: number): [number, number] {
  const start = Date.UTC(year, 2, nthSunday(year, 2, 2), 2 + 5); // 02:00 EST = 07:00 UTC
  const end = Date.UTC(year, 10, nthSunday(year, 10, 1), 2 + 4); // 02:00 EDT = 06:00 UTC
  return [start, end];
}

/** UTC offset of Eastern time at a UTC instant, in hours (4 in summer, 5 in winter). */
export function easternOffsetH(utcMs: number): 4 | 5 {
  const [s, e] = dstWindow(new Date(utcMs).getUTCFullYear());
  return utcMs >= s && utcMs < e ? 4 : 5;
}

/** Eastern local wall-clock → UTC epoch ms. */
export function easternToUtc(y: number, month1: number, d: number, h: number, mi: number, s = 0): number {
  const asEst = Date.UTC(y, month1 - 1, d, h + 5, mi, s);
  // Try EDT first; it is right iff that instant is inside DST.
  const asEdt = asEst - 3600_000;
  return easternOffsetH(asEdt) === 4 ? asEdt : asEst;
}

/** Eastern local weekday (0 = Sunday) and minutes since local midnight for a UTC instant. */
export function easternClock(utcMs: number): { weekday: number; minutes: number } {
  const local = new Date(utcMs - easternOffsetH(utcMs) * 3600_000);
  return { weekday: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
