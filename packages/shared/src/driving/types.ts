export type Activity = 'automotive' | 'cycling' | 'running' | 'walking' | 'still' | 'unknown';

export interface LocationSample {
  /** Epoch ms. */
  t: number;
  lat: number;
  lng: number;
  /** m/s, null when the fix has no speed. */
  speed: number | null;
  /** Degrees from north, null when unknown/stationary. */
  heading: number | null;
  accuracy: number;
  altitude?: number | null;
}

export interface ActivitySample {
  t: number;
  activity: Activity;
  /** 0–100. */
  confidence: number;
}

/** Linear acceleration magnitude sample (gravity removed), m/s². */
export interface ImuSample {
  t: number;
  magnitude: number;
}

export interface InteractionSample {
  t: number;
  kind: 'touch' | 'screenOn' | 'screenOff';
}

/** Posted speed limit in km/h at a moment, from route `maxspeed` or map matching. */
export interface SpeedLimitSample {
  t: number;
  limitKph: number | null;
}

export type Severity = 0 | 1 | 2; // minor, moderate, severe

export type RiskyEventKind =
  | 'hardBrake'
  | 'rapidAccel'
  | 'cornering'
  | 'speeding'
  | 'phoneHandling'
  | 'lateNight'
  | 'crash';

export interface RiskyEvent {
  id: string;
  kind: RiskyEventKind;
  severity: Severity;
  t: number;
  /** End time for episode events (speeding, phone handling, late night). */
  tEnd?: number;
  lat: number;
  lng: number;
  /** Kind-specific magnitude: m/s² for accel kinds, km/h over for speeding, seconds for phone, minutes for late night. */
  value: number;
  speedKph: number;
  limitKph?: number;
}

export interface TripPoint {
  t: number;
  lat: number;
  lng: number;
  speed: number;
  heading: number | null;
  limitKph: number | null;
}

export interface Trip {
  id: string;
  startedAt: number;
  endedAt: number;
  points: TripPoint[];
  events: RiskyEvent[];
  distanceM: number;
  durationS: number;
  topSpeedKph: number;
  avgSpeedKph: number;
  /** 0–100, null if excluded (passenger). */
  score: number | null;
  passenger: boolean;
}
