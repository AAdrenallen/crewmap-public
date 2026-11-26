/**
 * Dev replay time rate: replay fix timestamps advance `rate`× faster than the wall clock. The map motion smoother
 * runs on fix time, so it reads this to extrapolate at the replayed pace. 1 outside replays.
 */
let rate = 1;

export function replayRate(): number {
  return rate;
}

export function setReplayRate(r: number): void {
  rate = r > 0 ? r : 1;
}
