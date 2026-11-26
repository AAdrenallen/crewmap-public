import type { Fix } from '@crewmap/platform';
import { parseMapboxRoute } from '@crewmap/shared/navigation';
import { pointAlong } from '@crewmap/shared/geo';
import { engine } from './engine';
import { setReplayRate } from './replayClock';
import { useApp } from './store';

/**
 * Replay harness inside the app (dev builds only, prompt §5): feeds synthetic drives through the real
 * Tracking → DrivingPipeline / ArrivalDetector / RouteProgress path in the emulator. Never reachable in release:
 * callers guard on __DEV__, so Metro drops the fixture modules from production bundles.
 */
export type ReplayName = 'highway' | 'hardBrake' | 'speeding' | 'twoTurns' | 'walk' | 'drivingEmote';

/** Each run bumps this; an older run stops at its next step so replays never overlap. */
let generation = 0;
/** Wall-clock start of the running replay (pacing) and the replay-time end of the last one. */
let wallBase = 0;
let replayEnd = 0;

/**
 * Waits until replay time `offsetMs` (since the first fix) is due on the wall clock, scaled by `speedup`. Paced on an
 * absolute timeline, so the time spent processing a fix never stretches the cadence (no drift, no stalls).
 */
function pace(wallStart: number, offsetMs: number, speedup: number): Promise<void> {
  const wait = wallStart + offsetMs / speedup - Date.now();
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

export async function runReplay(name: ReplayName, speedup = 20): Promise<void> {
  if (!__DEV__) return;
  const my = ++generation;
  if (useApp.getState().nav?.active) engine.nav.end();
  const fx = await import('@crewmap/replay/fixtures');
  const mb = await import('@crewmap/replay/mapbox');
  // Replay time must start after the previous replay's trip was closed (its clock ran ahead of the wall clock), else the
  // trip detector sees these fixes as the past and folds them into the previous trip.
  wallBase = Date.now();
  const now = Math.max(wallBase, replayEnd + 60_000);
  setReplayRate(speedup);
  try {
    await play(name, speedup, my, now, fx, mb);
  } finally {
    if (my === generation) setReplayRate(1);
  }
}

async function play(
  name: ReplayName,
  speedup: number,
  my: number,
  now: number,
  fx: typeof import('@crewmap/replay/fixtures'),
  mb: typeof import('@crewmap/replay/mapbox'),
): Promise<void> {
  if (name === 'twoTurns' || name === 'drivingEmote') {
    const route = parseMapboxRoute(mb.twoTurnsRoute(fx.PLACES.valClair).routes[0]!, `replay-${now}`);
    useApp.getState().set({ nav: { route, candidates: [{ route, source: 'base', label: { kind: 'letter', letter: 'A' } }], destination: { name: 'Avenue Cedar', lat: route.geometry.at(-1)!.lat, lng: route.geometry.at(-1)!.lng }, progress: null, active: false, rerouting: false } });
    engine.nav.start();
    engine.tracking.injectActivity({ t: now, activity: 'automotive', confidence: 95 });
    const v = 50 / 3.6;
    const total = route.cum.at(-1)!;
    let i = 0;
    for (let s = 0; s <= total; s += v, i++) {
      const p = pointAlong(route.geometry, route.cum, s);
      const fix: Fix = { t: now + i * 1000, lat: p.lat, lng: p.lng, speed: v, heading: null, accuracy: 5, altitude: null };
      if (my !== generation) return;
      await pace(wallBase, i * 1000, speedup);
      if (my !== generation) return;
      await engine.tracking.injectFixes([fix]);
      if (name === 'drivingEmote' && i === 20) {
        const from = Object.keys(useApp.getState().friends)[0] ?? 'replay-friend';
        // A queue of emotes keeps a popup on screen for ~55 s: the device's accessibility tree is slow to sample (UI-thread busy with
        // the map), so a single 2.8 s popup can be missed by Maestro.
        const batch = Array.from({ length: 20 }, (_, k) => ({ id: `replay-${now}-${k}`, from, msg: { preset: 'honkHonk' as const }, at: Date.now() }));
        useApp.getState().set({ emotes: [...useApp.getState().emotes, ...batch] });
      }
    }
    if (my !== generation) return;
    engine.nav.end();
    replayEnd = now + i * 1000 + 15 * 60_000;
    await engine.tracking.finishReplay(replayEnd);
    return;
  }

  const drive =
    name === 'highway' ? fx.highwayDrive() : name === 'hardBrake' ? fx.hardBrakeDrive() : name === 'speeding' ? fx.speedingDrive() : fx.walk();
  const t0 = drive.locations[0]!.t;
  const acts = [...drive.activities];
  for (let i = 0; i < drive.locations.length; i++) {
    if (my !== generation) return;
    const l = drive.locations[i]!;
    while (acts.length && acts[0]!.t <= l.t) {
      const a = acts.shift()!;
      engine.tracking.injectActivity({ ...a, t: a.t - t0 + now });
    }
    const limit = drive.limits[i] ?? null;
    if (limit !== null && !useApp.getState().nav?.active) useApp.getState().set({ limitKph: limit });
    await pace(wallBase, l.t - t0, speedup);
    if (my !== generation) return;
    await engine.tracking.injectFixes([{ t: l.t - t0 + now, lat: l.lat, lng: l.lng, speed: l.speed, heading: l.heading, accuracy: l.accuracy, altitude: null }]);
  }
  if (my !== generation) return;
  // Close the trip in replay time (well past the stop timeout) instead of waiting for the wall clock to catch up.
  const lastT = drive.locations[drive.locations.length - 1]!.t - t0 + now;
  replayEnd = lastT + 15 * 60_000;
  await engine.tracking.finishReplay(replayEnd);
}
