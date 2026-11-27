/** Tunables for crew-sensor insights (road roughness, learned stop delays, leave-by). Covered by test/insight.test.ts. */
export const INSIGHT = {
  roughness: {
    /** Grid cell size the roughness is pooled in. */
    cellM: 50,
    /** Below this speed the phone's shaking says little about the road (30 km/h). */
    minSpeedMps: 8.3,
    /** Fixes worse than this cannot place a cell. */
    maxAccuracyM: 25,
    /** Speed the index is normalised to (54 km/h): faster driving shakes more on the same road. */
    refSpeedMps: 15,
    /** One linear-acceleration spike this big at speed is a pothole/bump candidate, m/s². */
    spikeMps2: 6,
    /** IMU samples per cell needed before the cell gets a value. */
    minSamples: 10,
    /** Index above which a road is "rough" (RMS m/s² at the reference speed). */
    roughIndex: 1.6,
    /** Distinct drivers who must hit a spike in the same cell before it becomes a pothole suggestion. */
    potholeDrivers: 2,
  },
  stops: {
    stopSpeedMps: 1.5,
    /** Shorter stops are slowdowns; longer ones are not traffic control (parking, drive-thru). */
    minStopS: 5,
    maxStopS: 180,
    /** Stops are pooled per cell and hour band. */
    cellM: 30,
    hourBand: 3,
    /** Observations needed before a cell's median wait is trusted. */
    minObs: 3,
  },
  leaveBy: {
    /** Past trips starting within this many minutes of the planned start count as comparable. */
    windowMin: 90,
    minTrips: 3,
    /** Duration percentile planned for: late less than one time in five. */
    percentile: 0.8,
    bufferS: 120,
  },
} as const;
