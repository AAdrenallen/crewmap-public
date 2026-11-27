/**
 * Right turn on red (D61). Allowed across Québec and most of North America, except on the island of Montréal
 * (Highway Safety Code; regulation C-24.2, r. 9.1 lists Montréal and the other island municipalities; SAAQ
 * "Turning right at a red light"). There a right turn at a signal waits for the green like a through move, so routers
 * that price every right turn the same underrate signalised right turns on the island.
 *
 * Coarse island outline ([lng, lat], ~0.5–1 km off the shoreline in places): good enough for a ranking-only cost of a
 * few seconds; Île Bizard and the small islands are left out.
 */
const MONTREAL_ISLAND: [number, number][] = [
  [-73.475, 45.705],
  [-73.5, 45.655],
  [-73.525, 45.58],
  [-73.535, 45.53],
  [-73.545, 45.5],
  [-73.535, 45.455],
  [-73.585, 45.44],
  [-73.65, 45.415],
  [-73.73, 45.425],
  [-73.8, 45.42],
  [-73.88, 45.405],
  [-73.97, 45.405],
  [-73.98, 45.44],
  [-73.93, 45.465],
  [-73.86, 45.5],
  [-73.78, 45.515],
  [-73.72, 45.53],
  [-73.665, 45.555],
  [-73.62, 45.595],
  [-73.57, 45.635],
  [-73.52, 45.69],
];

export function onMontrealIsland(lat: number, lng: number): boolean {
  let inside = false;
  const p = MONTREAL_ISLAND;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]!;
    const [xj, yj] = p[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Right turn on red is banned at this point (island-wide rule; posted signs elsewhere are not known to us). */
export function rightOnRedBanned(lat: number, lng: number): boolean {
  return onMontrealIsland(lat, lng);
}
