import { haversineM } from '@crewmap/shared/geo';
import { fuse, TYPE_FAMILY, type ConfidenceLevel } from './confidence';
import type { Hazard, HazardSourceId } from './types';

/** Max distance (m) for two reports of a family to be the same thing. */
const RADIUS_M: Record<string, number> = {
  enforcement: 300,
  camera: 60,
  accident: 250,
  hazard: 150,
  closure: 400,
  works: 500,
  jam: 600,
};

/** Max report-time gap for the same thing (cameras and works are long-lived). */
const WINDOW_MS: Record<string, number> = {
  enforcement: 2 * 3600_000,
  camera: Infinity,
  accident: 3 * 3600_000,
  hazard: 3 * 3600_000,
  closure: 24 * 3600_000,
  works: Infinity,
  jam: 3600_000,
};

const SOURCE_RANK: Record<HazardSourceId, number> = { quebec: 5, montreal: 5, waze: 4, osm: 3, 'waze-paid': 4, mapbox: 3, friends: 2, anon: 1 };

export interface MergedHazard extends Hazard {
  /** All contributing reports (for attribution: "Waze · Friends"). */
  sources: HazardSourceId[];
  memberIds: string[];
  /** Freshest report time among members (drives "reported X min ago"). */
  latestReportAt: number;
  /** Device ids of friends who reported a member. */
  reporters: string[];
  /** Fused confidence 0–1 (source reliability × corroboration × age; D42). */
  confidence: number;
  level: ConfidenceLevel;
  /** Marker opacity 0.3–1: police / speed traps fade with age. */
  fade: number;
  /** Independent reports per source, for the hazard sheet ("2 anonymous · 1 crew"). */
  mix: { source: HazardSourceId; n: number }[];
  /** Independent reports (one per friend device, anonymous event or feed). */
  independent: number;
}

/**
 * Merge hazards from all sources and de-duplicate by type family + distance + time. The representative is the
 * most authoritative source (official > Waze > Mapbox > friends > anonymous), ties by reliability; confirmations
 * add up; confidence is fused from the members (confidence.ts).
 */
export function mergeHazards(all: Hazard[], now: number): MergedHazard[] {
  const live = all.filter((h) => h.expiresAt > now);
  // Deterministic order: authority, reliability, recency.
  live.sort(
    (a, b) =>
      SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || b.reliability - a.reliability || b.reportedAt - a.reportedAt || a.id.localeCompare(b.id),
  );
  const clusters: MergedHazard[] = [];
  const members: Hazard[][] = [];
  const seenIds = new Set<string>();
  // A crew report also published anonymously comes back from the public network: same report, counted once.
  const shadowed = new Set(live.map((h) => h.alsoAs).filter((x): x is string => !!x));
  for (const h of live) {
    if (seenIds.has(h.id)) continue; // same alert shared by two friends' phones, or one report in two crews
    seenIds.add(h.id);
    if (shadowed.has(h.id)) continue;
    const fam = TYPE_FAMILY[h.type];
    const i = clusters.findIndex(
      (m) =>
        TYPE_FAMILY[m.type] === fam &&
        haversineM(m, h) <= RADIUS_M[fam]! + (h.uncertaintyM ?? 0) &&
        Math.abs(m.latestReportAt - h.reportedAt) <= WINDOW_MS[fam]! &&
        headingsCompatible(m.heading, h.heading),
    );
    const c = clusters[i];
    if (c) {
      if (!c.sources.includes(h.source)) c.sources.push(h.source);
      c.memberIds.push(h.id);
      members[i]!.push(h);
      if (h.by && !c.reporters.includes(h.by)) c.reporters.push(h.by);
      c.confirmations += h.confirmations;
      c.latestReportAt = Math.max(c.latestReportAt, h.reportedAt);
      c.expiresAt = Math.max(c.expiresAt, h.expiresAt);
      c.reliability = Math.max(c.reliability, h.reliability);
      continue;
    }
    clusters.push({
      ...h,
      sources: [h.source],
      memberIds: [h.id],
      latestReportAt: h.reportedAt,
      reporters: h.by ? [h.by] : [],
      confidence: 0,
      level: 'low',
      fade: 1,
      mix: [],
      independent: 1,
    });
    members.push([h]);
  }
  clusters.forEach((c, i) => Object.assign(c, fuse(members[i]!, c.type, c.latestReportAt, now)));
  return clusters;
}

function headingsCompatible(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d <= 60;
}

export const SOURCE_LABEL: Record<HazardSourceId, string> = {
  waze: 'Waze',
  'waze-paid': 'Waze',
  quebec: 'Québec 511',
  montreal: 'Ville de Montréal',
  osm: 'OpenStreetMap',
  mapbox: 'Mapbox',
  friends: 'Friends',
  anon: 'CrewMap',
};

export function attribution(h: MergedHazard): string {
  return [...new Set(h.sources.map((s) => SOURCE_LABEL[s]))].join(' · ');
}

export function ageMinutes(h: MergedHazard, now: number): number {
  return Math.max(0, Math.round((now - h.latestReportAt) / 60_000));
}

/** Licence/credit line per source, shown on the hazard detail screen (CC-BY requires it for official feeds). */
export const SOURCE_CREDIT: Record<HazardSourceId, string> = {
  waze: 'Waze',
  'waze-paid': 'Waze',
  quebec: 'Gouvernement du Québec (MTMD), CC-BY 4.0',
  montreal: 'Ville de Montréal, CC-BY 4.0',
  osm: '© OpenStreetMap contributors, ODbL',
  mapbox: '© Mapbox',
  friends: 'Friends',
  anon: 'CrewMap',
};

export function credits(h: MergedHazard): string[] {
  return [...new Set(h.sources.map((s) => SOURCE_CREDIT[s]))];
}
