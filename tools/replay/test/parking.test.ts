import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CircleAdmin,
  DEFAULT_TRANSPORT_CONFIG,
  encodeChat,
  fromUtf8,
  generateIdentity,
  KINDS,
  publicIdentity,
  replay,
  utf8,
  type CircleOp,
  type Kind,
} from '@crewmap/p2p';
import { destination, haversineM, type LatLng } from '@crewmap/shared/geo';
import type { LocationSample } from '@crewmap/shared/driving';
import { parkingShareText, parkingStep, parseParkingContext, type ParkingContext } from '@crewmap/shared/parking';
import { straight, T0 } from '../src/fixtures';
import { runParking } from '../src/runParking';
import { synthesize, type SynthDrive } from '../src/synth';
import { SimClock } from '../src/sim/clock';
import { PUBLIC_RELAY, SimDirectNet, SimRelayNet } from '../src/sim/network';
import { SimPhone, SimWakeNet } from '../src/sim/phone';

/** Synthetic Overpass responses around public landmarks (packages/shared/test/fixtures/parking-*.json). */
const fixture = (n: string) =>
  JSON.parse(readFileSync(join(__dirname, '../../../packages/shared/test/fixtures', `parking-${n}.json`), 'utf8')) as { spot: LatLng; osm: unknown };
const FX = { street: fixture('street'), driveway: fixture('driveway'), lot: fixture('lot') };
/** Stands in for the phone's Overpass lookup: the fixture whose spot the car stopped at. */
const contextAt = (p: LatLng): ParkingContext | null => {
  for (const f of Object.values(FX)) if (haversineM(p, f.spot) < 30) return parseParkingContext(f.osm, f.spot);
  return null;
};

/** 2 km drive from the south ending at `to`, then a 4-min stop (the trip detector ends it). */
function driveTo(to: LatLng, startAt = T0): SynthDrive {
  return synthesize({
    path: straight(destination(to, 180, 2000), 0, 2000, 20),
    startAt,
    phases: [
      { kind: 'ramp', toKph: 50, mps2: 2 },
      { kind: 'cruise', seconds: 138, kph: 50 },
      { kind: 'ramp', toKph: 0, mps2: 2.5 },
      { kind: 'stop', seconds: 240 },
    ],
  });
}

/** 2 km drive starting at `from` (the car leaving). */
function driveFrom(from: LatLng, startAt: number): SynthDrive {
  return synthesize({
    path: straight(from, 0, 2000, 20),
    startAt,
    phases: [
      { kind: 'ramp', toKph: 50, mps2: 2 },
      { kind: 'cruise', seconds: 130, kph: 50 },
      { kind: 'ramp', toKph: 0, mps2: 2.5 },
      { kind: 'stop', seconds: 240 },
    ],
  });
}

/** Walking away east at 1.4 m/s, one fix per 4 s. */
function walkAway(from: LatLng, t: number, m = 300): LocationSample[] {
  return straight(from, 90, m, 5.6).map((p, i) => ({ ...p, t: t + i * 4000, speed: 1.4, heading: 90, accuracy: 8 }));
}

const lastT = (d: SynthDrive) => d.locations[d.locations.length - 1]!.t;
const kinds = (r: ReturnType<typeof runParking>) => r.effects.map((e) => (e.type === 'skipped' ? `skipped:${e.reason}` : e.type === 'cleared' ? `cleared:${e.why}` : e.type));

describe('D67 where did I park (replay through the real trip pipeline)', () => {
  it('street park: saved on Rue Saint-Denis, facing the way it drove in, then the walk-away notice', () => {
    const d = driveTo(FX.street.spot);
    const r = runParking(d, { contextAt, after: walkAway(FX.street.spot, lastT(d) + 5000) });
    expect(r.trips).toBe(1);
    expect(kinds(r)).toEqual(['saved', 'walkedAway']);
    const s = r.state.spot!;
    expect(s.kind).toBe('street');
    expect(s.street).toBe('Rue Saint-Denis');
    expect(haversineM(s, FX.street.spot)).toBeLessThan(10);
    expect(Math.min(s.heading!, 360 - s.heading!)).toBeLessThan(5);
  });

  it('home driveway: skipped (saved Home place, and OSM driveway with no Home saved)', () => {
    const d = driveTo(FX.driveway.spot);
    const home = { type: 'home' as const, ...destination(FX.driveway.spot, 30, 20), radiusM: 60 };
    expect(kinds(runParking(d, { contextAt, places: [home] }))).toEqual(['skipped:home']);
    const r = runParking(d, { contextAt });
    expect(kinds(r)).toEqual(['skipped:driveway']);
    expect(r.state.spot).toBeNull();
  });

  it('parking lot: saved with the lot name', () => {
    const r = runParking(driveTo(FX.lot.spot), { contextAt });
    expect(kinds(r)).toEqual(['saved']);
    expect(r.state.spot).toMatchObject({ kind: 'lot', street: 'Stationnement du Stade' });
  });

  it('driving away again clears the spot', () => {
    const d1 = driveTo(FX.street.spot);
    const first = runParking(d1, { contextAt });
    expect(first.state.spot).not.toBeNull();
    const d2 = driveFrom(first.state.spot!, lastT(d1) + 2 * 3600_000);
    const r = runParking(d2, { contextAt, state: first.state });
    expect(kinds(r)[0]).toBe('cleared:droveAway');
    // The second drive ends 2 km north with no OSM data: that becomes the new (unknown) spot.
    expect(r.state.spot?.kind).toBe('unknown');
  });
});

describe('D67 privacy: the parked spot never rides crew traffic', () => {
  it('nothing a crewmate receives carries the spot, its note or its street, until "Share with crew" is tapped', async () => {
    const clock = new SimClock(T0);
    const relays = new SimRelayNet(clock);
    const publicRelays = ['wss://r1.sim'];
    relays.addRelay(publicRelays[0]!, { ...PUBLIC_RELAY, loss: 0, downtime: 0 });
    const direct = new SimDirectNet(clock, relays.online);
    const wakeNet = new SimWakeNet(clock);
    const [a, b] = [generateIdentity(), generateIdentity()];
    const admin = new CircleAdmin(a);
    let log: CircleOp[] = admin.create('Sim', 'A', T0);
    log = [...log, ...admin.add(replay(log, a), publicIdentity(b), 'B', T0)];
    const cfg = { config: { ...DEFAULT_TRANSPORT_CONFIG }, publicRelays, pcRelays: [] };
    const pa = new SimPhone('A', a, log, clock, relays, direct, wakeNet, cfg);
    const pb = new SimPhone('B', b, log, clock, relays, direct, wakeNet, cfg);
    pa.setState('foreground');
    pb.setState('foreground');
    const seen: { kind: Kind; text: string }[] = [];
    for (const k of Object.keys(KINDS) as Kind[]) pb.router.on(k, (m) => seen.push({ kind: k, text: fromUtf8(m.payload) }));

    // A drives to Rue Saint-Denis, parks, leaves a note and walks 300 m away. The app publishes presence the whole
    // time (the same JSON shape as core/tracking.ts) and the parking session runs beside it.
    const d = driveTo(FX.street.spot);
    const after = walkAway(FX.street.spot, lastT(d) + 5000);
    const r = runParking(d, { contextAt, after });
    const noted = parkingStep(r.state, { type: 'note', text: 'Level P2 spot 14' }).state;
    const spot = noted.spot!;
    const fixes = [...d.locations, ...after].filter((_, i) => i % 5 === 0);
    for (const f of fixes) {
      clock.setTimeout(() => {
        void pa.router.broadcast(
          'presence',
          utf8(JSON.stringify({ lat: f.lat, lng: f.lng, acc: 5, spd: f.speed, hdg: f.heading, act: 'automotive', bat: 80, chg: false, t: f.t, prec: 'p' })),
        );
      }, f.t - T0);
    }
    await clock.runUntil(after[after.length - 1]!.t + 30_000);

    expect(seen.filter((s) => s.kind === 'presence').length).toBeGreaterThan(50);
    const all = seen.map((s) => s.text).join('\n');
    expect(all).not.toContain('Level P2');
    expect(all).not.toContain('Saint-Denis');
    expect(all).not.toMatch(/tripId|parked|"note"/);
    // The last position friends see is where A walked to, not the car.
    const lastPresence = JSON.parse(seen.findLast((s) => s.kind === 'presence')!.text) as LatLng;
    expect(haversineM(lastPresence, spot)).toBeGreaterThan(200);

    // An explicit "Share with crew" is the one way out: a crew chat message with the street, the note and a map link.
    const msg = { id: 'm1', from: a.deviceId, to: null, text: parkingShareText(spot), t: clock.now() };
    void pa.router.broadcast('chat', encodeChat(msg));
    await clock.runUntil(clock.now() + 30_000);
    const chat = seen.find((s) => s.kind === 'chat');
    expect(chat?.text).toContain('Rue Saint-Denis');
    expect(chat?.text).toContain('Level P2 spot 14');
    expect(chat?.text).toContain(`mlat=${spot.lat.toFixed(5)}`);
  });
});
