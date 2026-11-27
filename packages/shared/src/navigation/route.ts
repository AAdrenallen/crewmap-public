import { parseLanes, type RawLane } from './lanes';
import { rightOnRedBanned } from './rightOnRed';
import { cumulativeDistances, decodePolyline, type LatLng } from '../geo';

export type ManeuverType =
  | 'depart'
  | 'arrive'
  | 'turn'
  | 'new name'
  | 'merge'
  | 'on ramp'
  | 'off ramp'
  | 'fork'
  | 'end of road'
  | 'continue'
  | 'roundabout'
  | 'rotary'
  | 'roundabout turn'
  | 'exit roundabout'
  | 'exit rotary'
  | 'notification';

export type ManeuverModifier =
  | 'uturn'
  | 'sharp right'
  | 'right'
  | 'slight right'
  | 'straight'
  | 'slight left'
  | 'left'
  | 'sharp left';

export interface Lane {
  /** Directions this lane allows, e.g. ['straight', 'right']. */
  directions: string[];
  /** Lane can be used to follow the route. */
  valid: boolean;
  /** Preferred lane(s) for the route. */
  active: boolean;
  activeDirection?: string;
}

export interface BannerComponent {
  text: string;
  type: 'text' | 'icon' | 'delimiter' | 'exit' | 'exit-number' | 'lane' | 'guidance-view' | string;
  /** Road shield image base URL (Mapbox) when type === 'icon'. */
  imageBaseURL?: string;
  abbr?: string;
}

export interface Banner {
  /** Instruction becomes active when the remaining distance in the step ≤ this. */
  distanceAlongGeometry: number;
  primary: { text: string; type: ManeuverType; modifier?: ManeuverModifier; degrees?: number; components: BannerComponent[] };
  secondary?: { text: string; components: BannerComponent[] };
  lanes?: Lane[];
}

export interface VoiceInstruction {
  distanceAlongGeometry: number;
  announcement: string;
}

export interface NavStep {
  index: number;
  maneuver: {
    type: ManeuverType;
    modifier?: ManeuverModifier;
    location: LatLng;
    bearingAfter: number;
    instruction: string;
    exit?: number;
  };
  name: string;
  ref?: string;
  distanceM: number;
  durationS: number;
  /** Distance along the whole route where this step starts / ends. */
  startAlongM: number;
  endAlongM: number;
  banners: Banner[];
  voice: VoiceInstruction[];
  /** The road driven during this step is a ramp/link (on- or off-ramp, interchange connector). */
  isRamp: boolean;
  /** Step drives over a bridge/overpass or through a tunnel (from intersection classes). */
  structures: ('bridge' | 'tunnel')[];
  /** Intersections passed in this step: other roads' bearings (deg) besides the way in and out. */
  junctions?: Junction[];
  /** Lanes Mapbox reports at this step's maneuver intersection (`intersections[0].lanes`), one entry per lane. */
  maneuverLanes?: Lane[];
  /** Mapbox Streets v8 class driven for most of this step ('motorway', 'primary', 'street', …), ramps ignored. */
  roadClass?: string;
}

export interface Junction {
  location: LatLng;
  /** Bearing leaving along the route. */
  out: number;
  /** Bearings of the side roads one could take instead. */
  side: number[];
}

export type Congestion = 'unknown' | 'low' | 'moderate' | 'heavy' | 'severe';

export interface RouteIncident {
  id: string;
  type: string;
  description: string;
  closed: boolean;
  /** Along-route range of the incident. */
  startAlongM: number;
  endAlongM: number;
  location: LatLng;
  congestion?: number;
}

export interface NavRoute {
  id: string;
  geometry: LatLng[];
  cum: number[];
  distanceM: number;
  durationS: number;
  /** Traffic-free duration if provided, for "delay" display. */
  typicalDurationS?: number;
  steps: NavStep[];
  /** Per geometry segment (length = geometry.length − 1). km/h, null = unknown/none. */
  maxspeedKph: (number | null)[];
  congestion: Congestion[];
  /** Per segment 0–100 (Mapbox `congestion_numeric`), null = unknown. Absent on routes parsed from older shapes. */
  congestionNumeric?: (number | null)[];
  /** Per segment live travel time (s) and speed (km/h), from `annotations=duration,speed`. */
  segDurationS?: number[];
  segSpeedKph?: (number | null)[];
  incidents: RouteIncident[];
  summary: string;
  /** Intersection controls and maneuvers along the route (for the recommendation's control-delay allowance). */
  controls?: RouteControls;
  /** `typicalDurationS` was estimated (via-waypoint routes come back without `duration_typical`). */
  typicalEstimated?: boolean;
  /** Along-route positions (m) of traffic signals, ascending (convoy "N lights back", D65). Absent when unknown. */
  signalsAlongM?: number[];
}

export interface RouteControls {
  signals: number;
  stops: number;
  yields: number;
  /** Real turns: maneuvers other than depart/arrive/continue/new name/merge and not straight on. */
  turns: number;
  /** Length driven on motorway/trunk roads and their ramps (m), measured per intersection span. */
  fastRoadM: number;
  /** Turns that cross oncoming traffic (left / sharp left, excluding ramps and roundabouts). */
  leftTurns?: number;
  /** Right / sharp-right turns at a traffic signal where right turn on red is banned (island of Montréal). */
  noRedRightTurns?: number;
  /** Length on local streets (street, street_limited, service, track) and on tertiary collectors (m). */
  minorRoadM?: number;
  tertiaryRoadM?: number;
  /** Length on toll roads (intersection class `toll`), m. */
  tollM?: number;
}

const NOT_TURNS = new Set(['depart', 'arrive', 'continue', 'new name', 'merge', 'notification']);
const FAST_CLASSES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const MINOR_CLASSES = new Set(['street', 'street_limited', 'service', 'track', 'path']);
const NO_LEFT = new Set(['roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary', 'on ramp', 'off ramp', 'fork', 'merge']);

/** Class of a road for naming and scoring: `_link` ramps count as their main class. */
export function baseRoadClass(cls: string): string {
  return cls.endsWith('_link') ? cls.slice(0, -5) : cls;
}

// --- Mapbox Directions v5 raw shapes (only the fields we use) -------------------------------------------------

interface MbComponent {
  text: string;
  type: string;
  imageBaseURL?: string;
  abbr?: string;
  directions?: string[];
  active?: boolean;
  active_direction?: string;
  indications?: string[];
  valid?: boolean;
  valid_indication?: string;
}
interface MbBanner {
  distanceAlongGeometry: number;
  primary: { text: string; type: string; modifier?: string; degrees?: number; components: MbComponent[] };
  secondary?: { text: string; components: MbComponent[] } | null;
  sub?: { text: string; components: MbComponent[] } | null;
}
interface MbStep {
  distance: number;
  duration: number;
  name: string;
  ref?: string;
  geometry: string;
  maneuver: { type: string; modifier?: string; location: [number, number]; bearing_after: number; instruction: string; exit?: number };
  bannerInstructions?: MbBanner[];
  voiceInstructions?: { distanceAlongGeometry: number; announcement: string }[];
  intersections?: { classes?: string[]; lanes?: RawLane[]; location: [number, number]; geometry_index?: number; mapbox_streets_v8?: { class?: string }; traffic_signal?: boolean; stop_sign?: boolean; yield_sign?: boolean; bearings?: number[]; entry?: boolean[]; in?: number; out?: number }[];
}
interface MbLeg {
  steps: MbStep[];
  annotation?: {
    maxspeed?: ({ speed: number; unit: 'km/h' | 'mph' } | { unknown: true } | { none: true })[];
    congestion?: string[];
    congestion_numeric?: (number | null)[];
    distance?: number[];
    duration?: number[];
    speed?: number[];
  };
  incidents?: {
    id: string;
    type: string;
    description?: string;
    closed?: boolean;
    congestion?: { value: number };
    geometry_index_start: number;
    geometry_index_end: number;
  }[];
  summary?: string;
}
export interface MbRoute {
  geometry: string;
  distance: number;
  duration: number;
  duration_typical?: number | null;
  legs: MbLeg[];
}
export interface MbDirectionsResponse {
  code: string;
  message?: string;
  routes: MbRoute[];
  uuid?: string;
}

function lanesFrom(sub: MbBanner['sub']): Lane[] | undefined {
  return parseLanes(sub?.components?.filter((c) => c.type === 'lane'));
}

const RAMP_TYPES = new Set(['on ramp', 'off ramp']);

/** Normalises a Mapbox Directions route (geometries=polyline6, steps, banner + voice instructions, annotations). */
export function parseMapboxRoute(r: MbRoute, id: string): NavRoute {
  const geometry = decodePolyline(r.geometry, 6);
  const cum = cumulativeDistances(geometry);
  const steps: NavStep[] = [];
  const maxspeedKph: (number | null)[] = [];
  const congestion: Congestion[] = [];
  const congestionNumeric: (number | null)[] = [];
  const segDurationS: number[] = [];
  const segSpeedKph: (number | null)[] = [];
  const incidents: RouteIncident[] = [];
  const signalsAlongM: number[] = [];
  let along = 0;
  let geomOffset = 0;
  const controls: RouteControls = { signals: 0, stops: 0, yields: 0, turns: 0, fastRoadM: 0, leftTurns: 0, noRedRightTurns: 0, minorRoadM: 0, tertiaryRoadM: 0, tollM: 0 };
  const addClassLen = (cls: string, m: number) => {
    if (FAST_CLASSES.has(cls)) controls.fastRoadM += m;
    else if (MINOR_CLASSES.has(cls)) controls.minorRoadM! += m;
    else if (baseRoadClass(cls) === 'tertiary') controls.tertiaryRoadM! += m;
  };

  for (const leg of r.legs) {
    const legFirstStep = steps.length;
    // Per intersection: the class of the road leaving it, driven until the next intersection (route-level indices).
    const spans: { gi: number; cls: string; step: number; toll: boolean }[] = [];
    let spansOk = true;
    let legSegs = 0;
    for (const ms of leg.annotation?.maxspeed ?? []) {
      if ('speed' in ms) maxspeedKph.push(ms.unit === 'mph' ? Math.round(ms.speed * 1.609344) : ms.speed);
      else maxspeedKph.push(null);
      legSegs++;
    }
    for (const c of leg.annotation?.congestion ?? []) {
      congestion.push((['low', 'moderate', 'heavy', 'severe'].includes(c) ? c : 'unknown') as Congestion);
    }
    for (const c of leg.annotation?.congestion_numeric ?? []) congestionNumeric.push(typeof c === 'number' ? c : null);
    for (const d of leg.annotation?.duration ?? []) segDurationS.push(d);
    for (const v of leg.annotation?.speed ?? []) segSpeedKph.push(typeof v === 'number' ? Math.round(v * 3.6 * 10) / 10 : null);
    for (const inc of leg.incidents ?? []) {
      const s = geomOffset + inc.geometry_index_start;
      const e = geomOffset + inc.geometry_index_end;
      const ri: RouteIncident = {
        id: inc.id,
        type: inc.type,
        description: inc.description ?? '',
        closed: inc.closed === true,
        startAlongM: cum[Math.min(s, cum.length - 1)] ?? 0,
        endAlongM: cum[Math.min(e, cum.length - 1)] ?? 0,
        location: geometry[Math.min(s, geometry.length - 1)]!,
      };
      if (inc.congestion) ri.congestion = inc.congestion.value;
      incidents.push(ri);
    }
    for (const st of leg.steps) {
      const classes = new Set((st.intersections ?? []).flatMap((i) => i.classes ?? []));
      const roadClasses = (st.intersections ?? []).map((i) => i.mapbox_streets_v8?.class ?? '');
      const isRamp = RAMP_TYPES.has(st.maneuver.type) || roadClasses.some((c) => c.endsWith('_link'));
      const structures: ('bridge' | 'tunnel')[] = [];
      if (classes.has('tunnel')) structures.push('tunnel');
      if (classes.has('bridge')) structures.push('bridge');
      for (const x of st.intersections ?? []) {
        if (x.traffic_signal) controls.signals++;
        if (x.traffic_signal && typeof x.geometry_index === 'number') signalsAlongM.push(cum[Math.min(geomOffset + x.geometry_index, cum.length - 1)] ?? 0);
        if (x.stop_sign) controls.stops++;
        if (x.yield_sign) controls.yields++;
      }
      if (!NOT_TURNS.has(st.maneuver.type) && !(st.maneuver.modifier ?? '').includes('straight')) controls.turns++;
      if (!NOT_TURNS.has(st.maneuver.type) && !NO_LEFT.has(st.maneuver.type) && (st.maneuver.modifier === 'left' || st.maneuver.modifier === 'sharp left')) controls.leftTurns!++;
      if (
        !NOT_TURNS.has(st.maneuver.type) &&
        !NO_LEFT.has(st.maneuver.type) &&
        (st.maneuver.modifier === 'right' || st.maneuver.modifier === 'sharp right') &&
        st.intersections?.[0]?.traffic_signal &&
        rightOnRedBanned(st.maneuver.location[1], st.maneuver.location[0])
      )
        controls.noRedRightTurns!++;
      for (const x of st.intersections ?? []) {
        if (typeof x.geometry_index !== 'number') spansOk = false;
        else spans.push({ gi: x.geometry_index, cls: x.mapbox_streets_v8?.class ?? (x.classes?.includes('motorway') ? 'motorway' : ''), step: steps.length, toll: x.classes?.includes('toll') === true });
      }
      const junctions: Junction[] = [];
      for (const x of st.intersections ?? []) {
        if (!x.bearings || x.out === undefined || x.bearings.length < 3) continue;
        const side = x.bearings.filter((_, bi) => bi !== x.out && bi !== x.in && x.entry?.[bi] !== false);
        junctions.push({ location: { lat: x.location[1], lng: x.location[0] }, out: x.bearings[x.out]!, side });
      }
      const step: NavStep = {
        index: steps.length,
        maneuver: {
          type: st.maneuver.type as ManeuverType,
          location: { lat: st.maneuver.location[1], lng: st.maneuver.location[0] },
          bearingAfter: st.maneuver.bearing_after,
          instruction: st.maneuver.instruction,
        },
        name: st.name,
        distanceM: st.distance,
        durationS: st.duration,
        startAlongM: along,
        endAlongM: along + st.distance,
        banners: (st.bannerInstructions ?? []).map((b) => {
          const banner: Banner = {
            distanceAlongGeometry: b.distanceAlongGeometry,
            primary: {
              text: b.primary.text,
              type: b.primary.type as ManeuverType,
              components: b.primary.components.map(comp),
            },
          };
          if (b.primary.modifier) banner.primary.modifier = b.primary.modifier as ManeuverModifier;
          if (b.primary.degrees !== undefined) banner.primary.degrees = b.primary.degrees;
          if (b.secondary) banner.secondary = { text: b.secondary.text, components: b.secondary.components.map(comp) };
          const lanes = lanesFrom(b.sub);
          if (lanes) banner.lanes = lanes;
          return banner;
        }),
        voice: (st.voiceInstructions ?? []).map((v) => ({
          distanceAlongGeometry: v.distanceAlongGeometry,
          announcement: v.announcement,
        })),
        isRamp,
        structures,
      };
      if (st.maneuver.modifier) step.maneuver.modifier = st.maneuver.modifier as ManeuverModifier;
      if (st.maneuver.exit !== undefined) step.maneuver.exit = st.maneuver.exit;
      if (st.ref) step.ref = st.ref;
      if (junctions.length > 0) step.junctions = junctions;
      const ml = parseLanes(st.intersections?.[0]?.lanes);
      if (ml) step.maneuverLanes = ml;
      steps.push(step);
      along += st.distance;
    }
    // Road-class lengths per intersection span; older/partial responses fall back to the step's first intersection.
    const legEnd = legSegs > 0 ? geomOffset + legSegs : geometry.length - 1;
    const perStep = new Map<number, Map<string, number>>();
    if (spansOk && spans.length > 0) {
      spans.forEach((sp, k) => {
        const a = cum[Math.min(geomOffset + sp.gi, cum.length - 1)] ?? 0;
        const next = spans[k + 1];
        const b = cum[Math.min(next ? geomOffset + next.gi : legEnd, cum.length - 1)] ?? a;
        const m = Math.max(0, b - a);
        addClassLen(sp.cls, m);
        if (sp.toll) controls.tollM! += m;
        const per = perStep.get(sp.step) ?? new Map<string, number>();
        per.set(sp.cls, (per.get(sp.cls) ?? 0) + m);
        perStep.set(sp.step, per);
      });
    } else {
      leg.steps.forEach((st, i) => {
        const c0 = st.intersections?.[0];
        const cls0 = c0?.mapbox_streets_v8?.class ?? (c0?.classes?.includes('motorway') ? 'motorway' : '');
        addClassLen(cls0, st.distance);
        if (c0?.classes?.includes('toll')) controls.tollM! += st.distance;
        perStep.set(legFirstStep + i, new Map([[cls0, st.distance]]));
      });
    }
    for (const [si, per] of perStep) {
      // Ramps name a step's class only when the step is all ramps.
      const ranked = [...per].filter(([cls]) => cls !== '').sort((a, b) => Number(a[0].endsWith('_link')) - Number(b[0].endsWith('_link')) || b[1] - a[1]);
      if (ranked[0]) steps[si]!.roadClass = baseRoadClass(ranked[0][0]);
    }
    geomOffset += legSegs;
  }

  // Step distances from Mapbox and our haversine sum differ by < 0.5%; rescale so steps tile the geometry exactly.
  const total = cum[cum.length - 1] ?? 0;
  const k = along > 0 ? total / along : 1;
  for (const s of steps) {
    s.startAlongM *= k;
    s.endAlongM *= k;
  }

  const route: NavRoute = {
    id,
    geometry,
    cum,
    distanceM: r.distance,
    durationS: r.duration,
    steps,
    maxspeedKph,
    congestion,
    incidents,
    summary: r.legs.map((l) => l.summary ?? '').filter(Boolean).join(', '),
    controls,
  };
  if (congestionNumeric.length) route.congestionNumeric = congestionNumeric;
  if (segDurationS.length) route.segDurationS = segDurationS;
  if (segSpeedKph.length) route.segSpeedKph = segSpeedKph;
  if (signalsAlongM.length) route.signalsAlongM = signalsAlongM.sort((a, b) => a - b);
  // Via-waypoint routes come back with `duration_typical: null`.
  if (typeof r.duration_typical === 'number') route.typicalDurationS = r.duration_typical;
  return route;
}

function comp(c: MbComponent): BannerComponent {
  const out: BannerComponent = { text: c.text, type: c.type };
  if (c.imageBaseURL) out.imageBaseURL = c.imageBaseURL;
  if (c.abbr) out.abbr = c.abbr;
  return out;
}

/** Mapbox `exclude` classes the user can avoid. */
export type RouteExclude = 'toll' | 'motorway' | 'ferry';

/** Per-user routing preferences (persisted by the app; read by every Directions request it makes). */
export interface RouteOptions {
  avoidTolls: boolean;
  avoidHighways: boolean;
  avoidFerries: boolean;
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = { avoidTolls: false, avoidHighways: false, avoidFerries: false };

/** Stored value (possibly older / partial) to complete options. */
export function normalizeRouteOptions(v: unknown): RouteOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof RouteOptions, unknown>>;
  return { avoidTolls: o.avoidTolls === true, avoidHighways: o.avoidHighways === true, avoidFerries: o.avoidFerries === true };
}

/** Options to Mapbox `exclude` values, in a stable order. */
export function excludeList(o: RouteOptions): RouteExclude[] {
  return [...(o.avoidTolls ? (['toll'] as const) : []), ...(o.avoidHighways ? (['motorway'] as const) : []), ...(o.avoidFerries ? (['ferry'] as const) : [])];
}

export interface DirectionsRequest {
  coordinates: LatLng[];
  alternatives?: boolean;
  /** Current heading (deg) to avoid U-turn starts. */
  bearing?: number | null;
  language?: 'en' | 'fr' | 'ru';
  exclude?: RouteExclude[];
  /** Per-coordinate bearing constraints (overrides `bearing`). */
  bearings?: ({ deg: number; range: number } | null)[];
  /** Per-coordinate snap radius in m (null = unlimited). */
  radiuses?: (number | null)[];
  /** Only the first and last coordinates are stops; the others are silent vias (`waypoints=0;n`). */
  silentVias?: boolean;
  /** Points the route must not pass (`exclude=point(lng lat)`), used by discovery's corridor probe. */
  excludePoints?: LatLng[];
}

/** Builds a Mapbox Directions `driving-traffic` URL with everything the guidance UI needs. */
export function directionsUrl(req: DirectionsRequest, accessToken: string): string {
  const coords = req.coordinates.map((c) => `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`).join(';');
  const p = new URLSearchParams({
    access_token: accessToken,
    alternatives: String(req.alternatives ?? true),
    geometries: 'polyline6',
    overview: 'full',
    steps: 'true',
    banner_instructions: 'true',
    voice_instructions: 'true',
    voice_units: 'metric',
    roundabout_exits: 'true',
    annotations: 'maxspeed,congestion,congestion_numeric,distance,duration,speed',
    language: req.language ?? 'en',
  });
  if (req.bearings) {
    p.set('bearings', req.bearings.map((b) => (b ? `${Math.round(b.deg)},${Math.round(b.range)}` : '')).join(';'));
  } else if (req.bearing !== null && req.bearing !== undefined) {
    p.set('bearings', [`${Math.round(req.bearing)},45`, ...req.coordinates.slice(1).map(() => '')].join(';'));
  }
  if (req.radiuses?.some((r) => r !== null)) p.set('radiuses', req.radiuses.map((r) => (r === null ? 'unlimited' : String(r))).join(';'));
  if (req.silentVias && req.coordinates.length > 2) p.set('waypoints', `0;${req.coordinates.length - 1}`);
  const exclude = [...(req.exclude ?? []), ...(req.excludePoints ?? []).map((q) => `point(${q.lng.toFixed(6)} ${q.lat.toFixed(6)})`)];
  if (exclude.length > 0) p.set('exclude', exclude.join(','));
  return `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?${p.toString()}`;
}
