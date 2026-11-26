import { bearingDeg, destination, encodePolyline, haversineM, type LatLng } from '@crewmap/shared/geo';
import type { MbDirectionsResponse } from '@crewmap/shared/navigation';

export interface FixtureLeg {
  /** Heading of this road segment. */
  bearing: number;
  lengthM: number;
  name: string;
  ref?: string;
  /** Maneuver at the START of this segment (Mapbox semantics). */
  type: string;
  modifier?: string;
  kph: number;
  limitKph: number | null;
  roadClass?: string;
}

const verb = (type: string, modifier?: string): string => {
  if (type === 'depart') return 'Head';
  if (type === 'arrive') return 'You have arrived';
  if (type === 'off ramp') return `Take the ramp on the ${modifier?.includes('left') ? 'left' : 'right'}`;
  if (type === 'on ramp') return `Take the ramp on the ${modifier?.includes('left') ? 'left' : 'right'}`;
  if (type === 'merge') return 'Merge';
  return `Turn ${modifier ?? 'straight'}`;
};

/**
 * Builds a Mapbox Directions v5 response (same field names/semantics as the real API: banner/voice
 * `distanceAlongGeometry` = remaining distance in the step, maxspeed/congestion annotations per segment) for a
 * route made of straight legs. Used where a recorded response isn't practical; a recorded real response is
 * covered by `navigation.contract.test.ts`.
 */
export function buildDirections(start: LatLng, legs: FixtureLeg[], stepM = 25): MbDirectionsResponse {
  const coords: LatLng[] = [start];
  const legCoords: LatLng[][] = [];
  let cur = start;
  for (const leg of legs) {
    const pts: LatLng[] = [cur];
    for (let d = stepM; d < leg.lengthM; d += stepM) pts.push(destination(cur, leg.bearing, d));
    const end = destination(cur, leg.bearing, leg.lengthM);
    pts.push(end);
    legCoords.push(pts);
    coords.push(...pts.slice(1));
    cur = end;
  }
  const maxspeed: ({ speed: number; unit: 'km/h' } | { unknown: true })[] = [];
  const congestion: string[] = [];
  const distance: number[] = [];
  legs.forEach((leg, i) => {
    const pts = legCoords[i]!;
    for (let k = 1; k < pts.length; k++) {
      maxspeed.push(leg.limitKph === null ? { unknown: true } : { speed: leg.limitKph, unit: 'km/h' });
      congestion.push(leg.kph < 30 ? 'heavy' : 'low');
      distance.push(haversineM(pts[k - 1]!, pts[k]!));
    }
  });
  const steps = legs.map((leg, i) => {
    const pts = legCoords[i]!;
    const nextLeg = legs[i + 1];
    const nextText =
      !nextLeg || nextLeg.type === 'arrive' ? 'You have arrived' : `${verb(nextLeg.type, nextLeg.modifier)} onto ${nextLeg.name}`;
    const nextType = nextLeg?.type ?? 'arrive';
    const voice: { distanceAlongGeometry: number; announcement: string }[] = [];
    for (const v of [1000, 400, 60]) {
      if (leg.lengthM > v + 20) voice.push({ distanceAlongGeometry: v, announcement: `In ${v} metres, ${nextText}` });
    }
    voice.push({ distanceAlongGeometry: Math.min(leg.lengthM, 40), announcement: nextText });
    if (voice.length > 1) voice.sort((a, b) => b.distanceAlongGeometry - a.distanceAlongGeometry);
    return {
      distance: leg.lengthM,
      duration: leg.lengthM / (leg.kph / 3.6),
      name: leg.name,
      ...(leg.ref ? { ref: leg.ref } : {}),
      geometry: encodePolyline(pts, 6),
      maneuver: {
        type: leg.type,
        ...(leg.modifier ? { modifier: leg.modifier } : {}),
        location: [pts[0]!.lng, pts[0]!.lat] as [number, number],
        bearing_after: Math.round(bearingDeg(pts[0]!, pts[1]!)),
        instruction: `${verb(leg.type, leg.modifier)} onto ${leg.name}`,
      },
      bannerInstructions: [
        {
          distanceAlongGeometry: leg.lengthM,
          primary: {
            text: nextLeg?.name ?? 'Destination',
            type: nextType,
            ...(nextLeg?.modifier ? { modifier: nextLeg.modifier } : {}),
            components: [{ text: nextLeg?.name ?? 'Destination', type: 'text' }],
          },
          sub:
            nextLeg && nextLeg.type !== 'arrive'
              ? {
                  text: '',
                  components: [
                    { text: '', type: 'lane', directions: ['left'], active: nextLeg.modifier?.includes('left') ?? false },
                    { text: '', type: 'lane', directions: ['straight'], active: false },
                    { text: '', type: 'lane', directions: ['right'], active: nextLeg.modifier?.includes('right') ?? false },
                  ],
                }
              : null,
        },
      ],
      voiceInstructions: voice,
      intersections: [
        { location: [pts[0]!.lng, pts[0]!.lat] as [number, number], mapbox_streets_v8: { class: leg.roadClass ?? 'street' } },
      ],
    };
  });
  const total = legs.reduce((s, l) => s + l.lengthM, 0);
  const duration = steps.reduce((s, st) => s + st.duration, 0);
  return {
    code: 'Ok',
    routes: [
      {
        geometry: encodePolyline(coords, 6),
        distance: total,
        duration,
        legs: [{ steps, annotation: { maxspeed, congestion, distance }, summary: legs.map((l) => l.name).join(', ') }],
      },
    ],
  };
}

/** City route with two turns 150 m apart: right onto Rue A, then 150 m later left onto Rue B. */
export function twoTurnsRoute(start: LatLng): MbDirectionsResponse {
  return buildDirections(start, [
    { bearing: 90, lengthM: 900, name: 'Rue Centrale', type: 'depart', kph: 50, limitKph: 50 },
    { bearing: 180, lengthM: 150, name: 'Rue Érable', type: 'turn', modifier: 'right', kph: 40, limitKph: 40 },
    { bearing: 90, lengthM: 700, name: 'Avenue Cedar', type: 'turn', modifier: 'left', kph: 50, limitKph: 50 },
    { bearing: 90, lengthM: 0.001, name: 'Avenue Cedar', type: 'arrive', kph: 50, limitKph: 50 },
  ]);
}

/** Highway route with an off-ramp: 3 km on A-15 then a 600 m ramp to the A-640. */
export function highwayRampRoute(start: LatLng): MbDirectionsResponse {
  return buildDirections(start, [
    { bearing: 330, lengthM: 3000, name: 'Autoroute des Highlands', ref: 'A-15', type: 'depart', kph: 100, limitKph: 100, roadClass: 'motorway' },
    { bearing: 300, lengthM: 600, name: 'Sortie 19', type: 'off ramp', modifier: 'slight right', kph: 60, limitKph: 70, roadClass: 'motorway_link' },
    { bearing: 270, lengthM: 2000, name: 'Autoroute 640', ref: 'A-640', type: 'merge', modifier: 'slight left', kph: 100, limitKph: 100, roadClass: 'motorway' },
    { bearing: 270, lengthM: 0.001, name: 'Autoroute 640', type: 'arrive', kph: 100, limitKph: 100 },
  ]);
}
