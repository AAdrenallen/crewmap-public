import type { BBox } from '@crewmap/shared/geo';
import { REGIE_MAX_AGE_MS } from './regie';
import type { Poi } from './types';

export * from './types';
export * from './regie';
export * from './osmPois';
export * from './mtmdCameras';
export * from './ocm';
export * from './fuel';
export { OverpassCells, overpassUrl, type CellRecord, type OverpassCellOptions } from '../sources/overpass';

/** Points received from the crew's chore peer; the newest copy of each id wins, dropped after two days. */
export class SharedPois {
  private readonly byId = new Map<string, Poi>();

  ingest(list: Poi[], now: number): number {
    let n = 0;
    for (const p of list) {
      const cur = this.byId.get(p.id);
      if (cur && cur.at >= p.at) continue;
      if (now - p.at > REGIE_MAX_AGE_MS && p.kind === 'fuel' && p.prices) continue;
      this.byId.set(p.id, p);
      n++;
    }
    for (const [id, p] of this.byId) if (now - p.at > 30 * 86_400_000) this.byId.delete(id);
    return n;
  }

  within(b: BBox): Poi[] {
    return [...this.byId.values()].filter((p) => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east);
  }

  all(): Poi[] {
    return [...this.byId.values()];
  }

  restore(list: Poi[] | null, now: number): void {
    if (Array.isArray(list)) this.ingest(list, now);
  }
}
