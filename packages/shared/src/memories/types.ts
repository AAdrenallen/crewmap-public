import type { EmotePreset } from '../emotes';

/** A timed position (my drive, a crewmate's recorded or shared track). */
export interface TrackPt {
  t: number;
  lat: number;
  lng: number;
  /** m/s */
  spd?: number | null;
}

/** What the grouping needs of one of my drives (a thinned timed line, never the raw history). */
export interface TripLite {
  id: string;
  startedAt: number;
  endedAt: number;
  distanceM: number;
  durationS: number;
  topSpeedKph: number;
  passenger: boolean;
  line: TrackPt[];
}

/** A crewmate who was there, with when they joined and left. */
export interface OutingMember {
  id: string;
  joinedAt: number;
  leftAt: number;
  togetherMs: number;
  /** Joined through a drive-along / group drive session (not only by distance). */
  session?: boolean;
}

export interface OutingStop {
  lat: number;
  lng: number;
  start: number;
  end: number;
  /** Filled in by the app (my place name or the city); null when unknown. */
  name?: string | null;
}

export type NotableReason = 'longDay' | 'roadTrip' | 'record' | 'newCity';

export interface Outing {
  /** Stable while its first drive stays the first one: `o-<first trip id>`. */
  id: string;
  start: number;
  end: number;
  tripIds: string[];
  distanceM: number;
  drivingS: number;
  topSpeedKph: number;
  members: OutingMember[];
  stops: OutingStop[];
  kind: 'group' | 'notable';
  notable: NotableReason[];
}

/** An emote or ping exchanged during an outing (local log, D58 presets). */
export interface MemoryEvent {
  t: number;
  /** Sender device id. */
  from: string;
  /** Recipient device id, or 'crew'. */
  to: string;
  preset: EmotePreset | 'custom';
}

/** What a crewmate chose to share about the same outing (already narrowed by their sharing policy). */
export interface RemotePost {
  from: string;
  mid: string;
  window: [number, number];
  title?: string;
  route?: TrackPt[];
  km?: number;
  min?: number;
  topKph?: number;
  at: number;
}

export interface MemoryPhoto {
  /** Content hash of the compressed JPEG. */
  h: string;
  from: string;
  at: number;
  w: number;
  hgt: number;
  cap?: string;
  /** Local file, once held. */
  uri?: string;
}

export interface MemoryReact {
  from: string;
  /** 'memory' or a photo hash. */
  target: string;
  e: string;
  at: number;
}
