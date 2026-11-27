/** Tunables for "Where did I park" (D67). Covered by test/parking.test.ts. */
export const PARKING = {
  /** Own saved places of these types are never remembered as a parking spot (the car is at home). */
  skipPlaceTypes: ['home', 'home2'] as readonly string[],
  /** A stop this far outside a skipped place's radius still counts as that place (driveway at the edge). */
  placeMarginM: 40,
  /** Overpass lookup radius around the spot (roads, parking areas, buildings). */
  lookupRadiusM: 40,
  /** Spot within this of a street centreline: street parking (half a wide street plus GPS error). */
  streetMaxM: 14,
  /** Spot inside a parking area, or within this of its outline / node: lot. */
  lotNearM: 12,
  /** A driveway or private service way within this, nearer than any street: a driveway (skipped). */
  drivewayMaxM: 10,
  /** A house within this and no street within `streetMaxM`: private residential spot (skipped). */
  houseNearM: 25,
  /** Fixes worse than this cannot place a car; the last good one is used. */
  maxAccuracyM: 50,
  /** Walked this far from the car: the "Parked on …" notification. */
  walkAwayM: 40,
  /** ...only this soon after parking (a later walk past the car says nothing). */
  walkAwayWindowMs: 30 * 60_000,
  /** A new drive starting this close to the car: the car drove away, the spot is cleared. */
  driveAwayM: 250,
  /** Walking to the car ends this close to it. */
  arrivedM: 20,
  /** "Forget after" choices in hours; 0 = keep until the next drive. */
  forgetAfterOptionsH: [12, 24, 72, 0] as readonly number[],
  defaultForgetAfterH: 24,
  /** Note length (level / spot). */
  noteMax: 80,
} as const;

export type ParkingThresholds = typeof PARKING;

/** OSM `highway` values a car can park along. */
export const STREET_HIGHWAYS: readonly string[] = [
  'residential',
  'living_street',
  'unclassified',
  'tertiary',
  'tertiary_link',
  'secondary',
  'secondary_link',
  'primary',
  'primary_link',
  'service',
  'road',
];

/** OSM `building` values that are someone's home. */
export const RESIDENTIAL_BUILDINGS: readonly string[] = [
  'house',
  'detached',
  'semidetached_house',
  'terrace',
  'residential',
  'bungalow',
  'duplex',
  'farm',
  'cabin',
  'static_caravan',
];
