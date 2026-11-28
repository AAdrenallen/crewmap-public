import { RiskyEventDetector } from './riskyEvents';
import { tripScore } from './score';
import { TripDetector, type TripState } from './tripDetector';
import type {
  ActivitySample,
  ImuSample,
  InteractionSample,
  LocationSample,
  RiskyEvent,
  Trip,
  TripPoint,
} from './types';

export interface DrivingPipelineListener {
  onTripStarted?(startedAt: number): void;
  onPoint?(p: TripPoint): void;
  onEvent?(e: RiskyEvent): void;
  onTripEnded?(trip: Trip): void;
}

export interface DrivingPipelineOptions {
  newId: () => string;
  localHour?: (t: number) => number;
}

/**
 * The on-device driving pipeline: location/activity/IMU/interaction streams in, trips with risky events and a
 * score out. Used by the background location task and by the replay harness (same code path).
 */
export class DrivingPipeline {
  private readonly detector = new TripDetector();
  private events: RiskyEventDetector | null = null;
  private tripId = '';
  /** Interactions/IMU that arrive before the trip is confirmed are replayed into the event detector. */
  private pendingImu: ImuSample[] = [];
  private pendingTouches: InteractionSample[] = [];

  constructor(
    private readonly opts: DrivingPipelineOptions,
    private readonly listener: DrivingPipelineListener = {},
  ) {}

  get state(): TripState {
    return this.detector.currentState;
  }

  get currentTripId(): string | null {
    return this.events ? this.tripId : null;
  }

  activity(a: ActivitySample): void {
    this.detector.onActivity(a);
  }

  imu(s: ImuSample): void {
    if (this.events) this.events.onImu(s);
    else this.buffer(this.pendingImu, s);
  }

  interaction(i: InteractionSample): void {
    if (this.events) this.events.onInteraction(i);
    else this.buffer(this.pendingTouches, i);
  }

  location(s: LocationSample, limitKph: number | null = null): Trip[] {
    return this.handle(this.detector.onLocation(s, limitKph));
  }

  tick(now: number): Trip[] {
    return this.handle(this.detector.tick(now));
  }

  flush(): Trip[] {
    return this.handle(this.detector.flush());
  }

  private buffer<T extends { t: number }>(arr: T[], v: T): void {
    arr.push(v);
    if (arr.length > 64 && v.t - arr[0]!.t > 90_000) {
      let cut = 0;
      while (cut < arr.length && v.t - arr[cut]!.t > 90_000) cut++;
      if (cut >= 32) arr.splice(0, cut);
    }
  }

  private handle(evs: ReturnType<TripDetector['onLocation']>): Trip[] {
    const done: Trip[] = [];
    for (const ev of evs) {
      switch (ev.type) {
        case 'started': {
          this.tripId = this.opts.newId();
          this.events = new RiskyEventDetector(this.tripId, undefined, this.opts.localHour);
          this.listener.onTripStarted?.(ev.startedAt);
          // Merge-replay buffered points, IMU and touches in time order.
          const imu = this.pendingImu.filter((x) => x.t >= ev.startedAt);
          const touches = this.pendingTouches.filter((x) => x.t >= ev.startedAt);
          this.pendingImu = [];
          this.pendingTouches = [];
          let ii = 0;
          let ti = 0;
          for (const p of ev.points) {
            while (ii < imu.length && imu[ii]!.t <= p.t) this.events.onImu(imu[ii++]!);
            while (ti < touches.length && touches[ti]!.t <= p.t) this.events.onInteraction(touches[ti++]!);
            this.emitEvents(this.events.onPoint(p));
            this.listener.onPoint?.(p);
          }
          break;
        }
        case 'point':
          if (this.events) this.emitEvents(this.events.onPoint(ev.point));
          this.listener.onPoint?.(ev.point);
          break;
        case 'ended': {
          const det = this.events;
          this.events = null;
          if (!det) break;
          this.emitEvents(det.finish());
          const events = det.all().filter((e) => e.t <= ev.endedAt + 1000);
          const durationS = (ev.endedAt - ev.startedAt) / 1000;
          const top = ev.points.reduce((m, p) => Math.max(m, p.speed), 0);
          const trip: Trip = {
            id: this.tripId,
            startedAt: ev.startedAt,
            endedAt: ev.endedAt,
            points: ev.points,
            events,
            distanceM: ev.distanceM,
            durationS,
            topSpeedKph: Math.round(top * 3.6),
            avgSpeedKph: durationS > 0 ? Math.round((ev.distanceM / durationS) * 3.6) : 0,
            score: tripScore(events, ev.distanceM, false),
            passenger: false,
          };
          this.listener.onTripEnded?.(trip);
          done.push(trip);
          break;
        }
        case 'discarded':
          this.events = null;
          break;
      }
    }
    return done;
  }

  private emitEvents(es: RiskyEvent[]): void {
    for (const e of es) this.listener.onEvent?.(e);
  }
}

/** "I was a passenger": removes the trip from scoring entirely (phone handling and everything else). */
export function markPassenger(trip: Trip, passenger: boolean): Trip {
  return { ...trip, passenger, score: tripScore(trip.events, trip.distanceM, passenger) };
}
