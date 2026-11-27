import { DrivingPipeline, type ImuSample } from '@crewmap/shared/driving';
import { assessStop, CheckInMonitor, type CheckInAction, type StopContext } from '@crewmap/shared/safety';
import type { SynthDrive } from './synth';

export interface CheckInRun {
  actions: (CheckInAction & { t: number })[];
  crashes: number[];
}

/**
 * Safety check-in (D66) through the real trip pipeline: fixes, activity and IMU go to `DrivingPipeline` (its 'crash'
 * event feeds the monitor, as `tracking.ts` does), the same fixes and walking activity to `CheckInMonitor`, ticked on
 * every fix in replay time like `apps/mobile/src/core/checkIn.ts`. `ctx` stands in for places / Overpass / hazards.
 */
export function runCheckIn(d: SynthDrive, ctx: StopContext, opts: { waitMin?: number; imu?: ImuSample[]; answerAt?: number } = {}): CheckInRun {
  const mon = new CheckInMonitor(opts.waitMin ?? 5);
  const out: CheckInRun = { actions: [], crashes: [] };
  const pipe = new DrivingPipeline(
    { newId: () => 'trip', localHour: () => 14 },
    {
      onEvent: (e) => {
        if (e.kind !== 'crash') return;
        out.crashes.push(e.t);
        mon.crash(e.t);
      },
    },
  );
  type Item = { t: number; k: 'loc' | 'act' | 'imu'; i: number };
  const items: Item[] = [
    ...d.locations.map((l, i) => ({ t: l.t, k: 'loc' as const, i })),
    ...d.activities.map((a, i) => ({ t: a.t, k: 'act' as const, i })),
    ...(opts.imu ?? []).map((s, i) => ({ t: s.t, k: 'imu' as const, i })),
  ];
  const order = { act: 0, imu: 1, loc: 2 };
  items.sort((a, b) => a.t - b.t || order[a.k] - order[b.k]);
  let answered = false;
  const push = (as: CheckInAction[], t: number) => out.actions.push(...as.map((a) => ({ ...a, t })));
  for (const it of items) {
    if (it.k === 'act') {
      const a = d.activities[it.i]!;
      pipe.activity(a);
      if (a.activity === 'walking' || a.activity === 'running') push(mon.walking(a.t), a.t);
      continue;
    }
    if (it.k === 'imu') {
      pipe.imu(opts.imu![it.i]!);
      continue;
    }
    const f = d.locations[it.i]!;
    pipe.location(f, d.limits[it.i] ?? null);
    push(mon.fix(f), f.t);
    if (!answered && opts.answerAt !== undefined && f.t >= opts.answerAt) {
      answered = true;
      push(mon.answer(f.t), f.t);
    }
    push(mon.tick(f.t, (s) => assessStop(s, ctx)), f.t);
  }
  return out;
}
