import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from '@crewmap/shared/geo';
import type { NavRoute } from '@crewmap/shared/navigation';
import {
  ANON,
  AnonHazardStore,
  AnonRateLimit,
  announceable,
  buildAnonReport,
  buildAnonVote,
  fuse,
  geohashDecode,
  geohashEncode,
  geohashesAlong,
  HazardAnnouncer,
  hazardsFromReports,
  hazardsOnRoute,
  isAnonVote,
  mergeHazards,
  normaliseQc,
  parseAnonEvent,
  type AnonEvent,
  type FriendReport,
  type Hazard,
  type ParsedAnonReport,
} from '../src';

const NOW = Date.UTC(2026, 10, 24, 15, 0);
/** Low PoW keeps the tests fast; one test runs the production difficulty. */
const BITS = 8;
const P = { lat: 45.6012, lng: -74.0031 };

function h(id: string, source: Hazard['source'], over: Partial<Hazard> = {}): Hazard {
  return {
    id, source, type: 'police', subtype: null, lat: P.lat, lng: P.lng, heading: null, street: null,
    reportedAt: NOW, expiresAt: NOW + 3600_000, reliability: source === 'anon' ? ANON.baseReliability : 6, confirmations: 0, ...over,
  };
}

describe('geohash', () => {
  it('round-trips and coarsens', () => {
    const g = geohashEncode(P, 7);
    expect(g).toHaveLength(7);
    const box = geohashDecode(g)!;
    expect(box.south).toBeLessThanOrEqual(P.lat);
    expect(box.north).toBeGreaterThanOrEqual(P.lat);
    expect(geohashEncode(P, 4)).toBe(g.slice(0, 4));
    expect(geohashDecode('a!')).toBeNull();
    const cells = geohashesAlong([{ lat: 45.5, lng: -74.2 }, { lat: 45.9, lng: -73.6 }], 4);
    expect(cells.length).toBeGreaterThan(2);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe('anonymous hazard message format (D41)', () => {
  it('carries no identifier, a coarse cell, a rounded time and a one-shot key', () => {
    const a = buildAnonReport({ type: 'police', lat: P.lat, lng: P.lng, heading: 93 }, NOW + 47_000, BITS);
    const b = buildAnonReport({ type: 'police', lat: P.lat, lng: P.lng, heading: 93 }, NOW + 47_000, BITS);
    expect(a.pubkey).not.toBe(b.pubkey); // fresh key per report
    const c = JSON.parse(a.content) as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(['c', 'h', 't', 'v']);
    expect(c.c).toBe(geohashEncode(P, ANON.cellPrecision));
    expect(c.h).toBe(2); // 93° → sector 2 of 8 (90°)
    expect(a.created_at % ANON.timeQuantumS).toBe(0);
    expect(a.tags.map((t) => t[0]).sort()).toEqual(['cap', 'expiration', 'g', 'nonce', 't']);
    expect(a.tags.find((t) => t[0] === 'g')![1]).toHaveLength(ANON.topicPrecision);
    // No exact coordinates anywhere in the event.
    expect(JSON.stringify(a)).not.toContain(P.lat.toFixed(3));
    expect(JSON.stringify(a)).not.toContain(String(P.lng).slice(0, 6));
    const p = parseAnonEvent(a, NOW + 60_000, BITS) as ParsedAnonReport;
    expect(p.type).toBe('police');
    expect(p.uncertaintyM).toBeGreaterThan(50);
    expect(p.uncertaintyM).toBeLessThan(150);
  });

  it('rejects tampering, missing PoW, extra fields, wrong topic, long TTL and unknown versions', () => {
    const a = buildAnonReport({ type: 'police', lat: P.lat, lng: P.lng, heading: null }, NOW, BITS);
    expect(parseAnonEvent({ ...a, content: a.content.replace('police', 'accident') }, NOW, BITS)).toBeNull(); // signature
    expect(parseAnonEvent(a, NOW, 40)).toBeNull(); // PoW below the required difficulty
    const forge = (content: object, tags = a.tags): AnonEvent => ({ ...a, content: JSON.stringify(content), tags });
    const ok = () => true;
    const base = JSON.parse(a.content) as Record<string, unknown>;
    expect(parseAnonEvent(forge(base), NOW, 0, ok)).not.toBeNull();
    expect(parseAnonEvent(forge({ ...base, device: 'x' }), NOW, 0, ok)).toBeNull();
    expect(parseAnonEvent(forge({ ...base, v: 2 }), NOW, 0, ok)).toBeNull();
    expect(parseAnonEvent(forge({ ...base, c: 'zzzzzzz' }), NOW, 0, ok)).toBeNull();
    const longTtl = a.tags.map((t) => (t[0] === 'expiration' ? ['expiration', String(a.created_at + 86_400)] : t));
    expect(parseAnonEvent(forge(base, longTtl), NOW, 0, ok)).toBeNull();
    expect(parseAnonEvent(a, NOW + 2 * 3600_000, BITS)).toBeNull(); // expired
  });

  it('meets the production proof-of-work difficulty', () => {
    const a = buildAnonReport({ type: 'speedTrap', lat: P.lat, lng: P.lng, heading: null }, NOW);
    expect(parseAnonEvent(a, NOW)).not.toBeNull();
  }, 30_000);

  it('caps reports per cell, counts votes once per key and drops "gone" reports', () => {
    const s = new AnonHazardStore();
    const evs = [0, 1, 2, 3].map((i) => buildAnonReport({ type: 'police', lat: P.lat, lng: P.lng, heading: null }, NOW + i * 1000, BITS));
    expect(evs.map((e) => s.ingest(e, NOW + 5000, BITS))).toEqual([true, true, true, false]);
    expect(s.ingest(evs[0]!, NOW + 5000, BITS)).toBe(false); // duplicate
    const target = s.get(evs[0]!.id)!;
    const up = buildAnonVote(target, true, NOW, BITS);
    expect(isAnonVote(parseAnonEvent(up, NOW, BITS)!)).toBe(true);
    expect(s.ingest(up, NOW, BITS)).toBe(true);
    const hz = s.hazards(NOW).find((x) => x.id === `anon:${evs[0]!.id}`)!;
    expect(hz.confirmations).toBe(1);
    expect(hz.reliability).toBe(ANON.baseReliability + 1);
    for (let i = 0; i < 3; i++) s.ingest(buildAnonVote(target, false, NOW, BITS), NOW, BITS);
    expect(s.hazards(NOW).some((x) => x.id === `anon:${evs[0]!.id}`)).toBe(false);
  });

  it('rate-limits local publishing', () => {
    const r = new AnonRateLimit();
    expect(r.canReport(NOW)).toBe(true);
    r.noteReport(NOW);
    expect(r.canReport(NOW + 30_000)).toBe(false);
    for (let i = 1; i < ANON.publish.maxPerHour; i++) r.noteReport(NOW + i * 61_000);
    expect(r.canReport(NOW + 20 * 61_000)).toBe(false);
    expect(r.canReport(NOW + 3600_000 + 11 * 61_000)).toBe(true);
  });
});

describe('fusion and confidence (D42)', () => {
  it('one anonymous report is not enough to announce police; two spread in time are', () => {
    const one = mergeHazards([h('anon:a', 'anon', { uncertaintyM: 90 })], NOW)[0]!;
    expect(one.level).not.toBe('high');
    expect(announceable(one)).toBe(false);
    const burst = mergeHazards([h('anon:a', 'anon'), h('anon:b', 'anon', { reportedAt: NOW - 30_000 })], NOW)[0]!;
    expect(burst.level).not.toBe('high'); // a burst could be one person with two keys
    const spread = mergeHazards([h('anon:a', 'anon'), h('anon:b', 'anon', { reportedAt: NOW - 5 * 60_000 })], NOW)[0]!;
    expect(spread.level).toBe('high');
    expect(spread.mix).toEqual([{ source: 'anon', n: 2 }]);
  });

  it('dedupes across sources and crews, counts each friend once, and shows the source mix', () => {
    const r: FriendReport = { id: 'r1', by: 'dev-a', type: 'police', lat: P.lat, lng: P.lng, heading: null, street: null, at: NOW, votes: { 'dev-a': 1 }, anonId: 'e'.repeat(64) };
    const fr = hazardsFromReports([r, r], NOW); // the same report seen in two crews
    const m = mergeHazards([...fr, h(`anon:${'e'.repeat(64)}`, 'anon'), h('anon:z', 'anon', { lat: P.lat + 0.001 }), h('quebec:event:1', 'quebec', { lat: P.lat - 0.001 })], NOW);
    expect(m).toHaveLength(1);
    expect(m[0]!.source).toBe('quebec');
    expect(m[0]!.memberIds).not.toContain(`anon:${'e'.repeat(64)}`); // the anonymous copy of r1 is not a second report
    expect(m[0]!.mix).toEqual(expect.arrayContaining([{ source: 'quebec', n: 1 }, { source: 'friends', n: 1 }, { source: 'anon', n: 1 }]));
    expect(m[0]!.level).toBe('high');
  });

  it('police confidence and marker opacity fade with age; cameras do not', () => {
    const fresh = fuse([h('f', 'friends', { by: 'x' })], 'police', NOW, NOW);
    const old = fuse([h('f', 'friends', { by: 'x' })], 'police', NOW - 50 * 60_000, NOW);
    expect(fresh.level).toBe('high');
    expect(old.confidence).toBeLessThan(fresh.confidence);
    expect(old.level).not.toBe('high');
    expect(old.fade).toBeLessThan(1);
    const cam = fuse([h('c', 'quebec', { type: 'camera' })], 'camera', NOW - 30 * 86_400_000, NOW);
    expect(cam.fade).toBe(1);
  });

  it('downvotes lower a friend report', () => {
    const up = fuse([h('f', 'friends', { by: 'x', reliability: 7 })], 'police', NOW, NOW).confidence;
    const down = fuse([h('f', 'friends', { by: 'x', reliability: 2 })], 'police', NOW, NOW).confidence;
    expect(down).toBeLessThan(up);
  });

  it('announces only high-confidence police on the route, never our own anonymous report', () => {
    const line = [{ lat: 45.6, lng: -74 }, { lat: 45.62, lng: -74 }];
    const route = { geometry: line, cum: cumulativeDistances(line) } as unknown as NavRoute;
    const cellCentre = { lat: 45.6101, lng: -74.0009 }; // ~70 m off the line: inside an anonymous cell's radius
    const lone = mergeHazards([h('anon:a', 'anon', { ...cellCentre, uncertaintyM: 90 })], NOW);
    const pair = mergeHazards([h('anon:a', 'anon', { ...cellCentre, uncertaintyM: 90 }), h('anon:b', 'anon', { ...cellCentre, uncertaintyM: 90, reportedAt: NOW - 4 * 60_000 })], NOW);
    expect(new HazardAnnouncer().update(hazardsOnRoute(route, lone), 0, null, { now: NOW })).toHaveLength(0);
    const on = hazardsOnRoute(route, pair);
    expect(on).toHaveLength(1);
    expect(new HazardAnnouncer().update(on, on[0]!.alongM - 700, null, { now: NOW })).toHaveLength(1);
    expect(new HazardAnnouncer().update(on, on[0]!.alongM - 700, null, { now: NOW, ownIds: new Set(['anon:b']) })).toHaveLength(0);
  });
});

describe('MTMD flood events and road conditions (recorded 2026-11-24)', () => {
  const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { features: Record<string, unknown>[] };
  it('maps flood restrictions to hazards / closures', () => {
    const f = fx('qc-inondation.json').features;
    const got = f.map((x) => normaliseQc('ms:evenements_inondation', x, NOW)).filter((x) => x !== null);
    expect(got.length).toBe(f.length);
    expect(got[0]!.type).toBe('hazard'); // "Circulation en alternance" is a lane restriction
    expect(got[0]!.description).toBe('Inondation');
  });

  it('ignores normal segments and reports snow-covered ones', () => {
    const [seg] = fx('qc-conditions.json').features;
    expect(normaliseQc('ms:conditions_routieres', seg, NOW)).toBeNull();
    const props = seg!.properties as Record<string, unknown>;
    const snowy = { ...seg, properties: { ...props, CodeEtatChaussee: 'En', DescriptionEtatChausseeFR: 'Enneigée' } };
    const got = normaliseQc('ms:conditions_routieres', snowy, NOW)!;
    expect(got.type).toBe('hazard');
    expect(got.description).toBe('Enneigée');
    expect(got.line!.length).toBeGreaterThan(1);
  });
});
