import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVATAR_PARTS, CAR_COLORS, CARS, DEFAULT_AVATAR, DEFAULT_CAR, headingFrame, normalizeAvatar, normalizeCar } from '../src/avatar';
import { en } from '../src/i18n/en';

interface Ride {
  scale: number;
  seat: [number, number, number];
  rider: number;
  pose: Record<'legL' | 'legR' | 'armL' | 'armR', [number, number]> & { lean: number; yaw: number };
}

const manifest = JSON.parse(readFileSync(new URL('../../../apps/mobile/assets/models/manifest.json', import.meta.url), 'utf8')) as {
  avatar: Record<string, string[]>;
  avatarTris: { worstCaseTris: number };
  cars: Record<string, number>;
  rides: Record<string, Ride>;
};

describe('F8a Blender pipeline output matches the app', () => {
  it('every avatar part id in the config exists in avatar.glb', () => {
    for (const key of ['body', 'hair', 'face', 'top', 'bottom', 'shoes', 'hat', 'glasses', 'accessory'] as const) {
      expect(manifest.avatar[key]!.sort()).toEqual([...AVATAR_PARTS[key]].sort());
    }
  });
  it('≥ 8 rides incl. something silly; within the triangle budget', () => {
    expect(Object.keys(manifest.cars).sort()).toEqual([...CARS].sort());
    expect(CARS).toContain('hotdog');
    // 16k: the polished kit (subdivided head, sculpted hair, lashed eyes, cloth seams) for the heaviest variant of
    // every slot at once (per-body fitted clothes count once); typical outfits are ~9–11k and a bake renders one
    // avatar at a time, so this stays cheap.
    expect(manifest.avatarTris.worstCaseTris).toBeLessThanOrEqual(16_000);
    for (const n of Object.values(manifest.cars)) expect(n).toBeLessThanOrEqual(4000);
  });
  it('every ride has a seat, sane scales and a full rider pose', () => {
    expect(Object.keys(manifest.rides).sort()).toEqual([...CARS].sort());
    for (const r of Object.values(manifest.rides)) {
      expect(r.seat).toHaveLength(3);
      expect(r.scale).toBeGreaterThan(0);
      // the rider never outgrows the walking avatar and stays recognisable at map size
      expect(r.rider).toBeGreaterThan(0.25);
      expect(r.rider).toBeLessThanOrEqual(1);
      for (const limb of ['legL', 'legR', 'armL', 'armR'] as const) {
        expect(r.pose[limb]).toHaveLength(2);
        for (const a of r.pose[limb]) expect(Math.abs(a)).toBeLessThanOrEqual(Math.PI);
      }
      expect(Number.isFinite(r.pose.lean) && Number.isFinite(r.pose.yaw)).toBe(true);
    }
  });
  it('every avatar part has a name', () => {
    for (const key of ['body', 'hair', 'face', 'top', 'bottom', 'shoes', 'hat', 'glasses', 'accessory'] as const) {
      for (const id of AVATAR_PARTS[key]) expect(en).toHaveProperty([`part.${key}.${id}`]);
    }
  });
  it('has the wardrobe the editor promises', () => {
    expect(AVATAR_PARTS.hair.length).toBeGreaterThanOrEqual(20);
    expect(AVATAR_PARTS.hat.length).toBeGreaterThanOrEqual(16);
    expect(AVATAR_PARTS.glasses.length).toBeGreaterThanOrEqual(16);
    expect(AVATAR_PARTS.accessory.length).toBeGreaterThanOrEqual(20);
    // part ids are matched by name prefix (`hair_<id>_...`): no underscores
    for (const ids of Object.values(AVATAR_PARTS)) for (const id of ids) expect(id).not.toContain('_');
  });
  it('every ride has a name', () => {
    for (const m of CARS) expect(en).toHaveProperty(`vehicle.${m}`);
  });
  it('maps headings to 16 sprite frames relative to map bearing', () => {
    expect(headingFrame(0)).toBe(0);
    expect(headingFrame(90)).toBe(4);
    expect(headingFrame(90, 90)).toBe(0);
    expect(headingFrame(359)).toBe(0);
    expect(headingFrame(null)).toBe(0);
  });
});

describe('normalizeCar (rides from peers on other versions)', () => {
  it('keeps a known ride', () => {
    expect(normalizeCar({ model: 'rocket', color: CAR_COLORS[0] })).toEqual({ model: 'rocket', color: CAR_COLORS[0] });
  });
  it('falls back on missing or garbage values', () => {
    for (const v of [undefined, null, 42, 'hotdog', [], {}]) expect(normalizeCar(v)).toEqual(DEFAULT_CAR);
  });
  it('replaces an unknown model but keeps a valid colour', () => {
    expect(normalizeCar({ model: 'hovercraft', color: '#43A047' })).toEqual({ model: DEFAULT_CAR.model, color: '#43A047' });
  });
  it('replaces a bad colour but keeps the model', () => {
    expect(normalizeCar({ model: 'skateboard', color: 'red' })).toEqual({ model: 'skateboard', color: DEFAULT_CAR.color });
  });
  it('drops unknown fields', () => {
    expect(normalizeCar({ model: 'van', color: '#212121', extra: 1 })).toEqual({ model: 'van', color: '#212121' });
  });
});

/** Part boxes per ride written by build_assets.py (vehicle-local Blender units, Z up, front = -Y). */
const geometry = JSON.parse(readFileSync(new URL('../../../tools/blender/rides-geometry.json', import.meta.url), 'utf8')) as Record<
  string,
  { parts: { n: string; min: number[]; max: number[] }[]; grips?: number[][] }
>;

type V3 = [number, number, number];
// avatar kit constants (build_assets.py HEAD_C, HR, HIP_Z, ARM_PIVOT, HAND_OFF)
const HEAD_Z = 0.74;
const HEAD_R = 0.22; // skull radius + hair volume
const HIP_Z = 0.3;
const rotX = (a: number, [x, y, z]: V3): V3 => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rotY = (a: number, [x, y, z]: V3): V3 => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const rotZ = (a: number, [x, y, z]: V3): V3 => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
/** Avatar-local point -> vehicle units, exactly as kit.ts buildRide / preview_rides.py compose the rider. */
function riderPoint(r: Ride, p: V3): V3 {
  const k = r.rider / r.scale;
  const q = rotZ(r.pose.yaw, rotX(r.pose.lean, [p[0] * k, p[1] * k, (p[2] - HIP_Z) * k]));
  return [r.seat[0] + q[0], r.seat[1] + q[1], r.seat[2] + q[2]];
}
function handOf(r: Ride, side: -1 | 1): V3 {
  const [rx, rz] = r.pose[side < 0 ? 'armL' : 'armR'];
  const local = rotX(rx, rotY(-rz, [side * 0.026, 0, -0.217]));
  return riderPoint(r, [side * 0.13 + local[0], local[1], 0.53 + local[2]]);
}
const boxDist = (c: V3, b: { min: number[]; max: number[] }) =>
  Math.hypot(...c.map((v, i) => Math.max(b.min[i]! - v, 0, v - b.max[i]!)));

describe('riders fit their rides (manifest + part boxes)', () => {
  it('the head never intersects any part of the vehicle', () => {
    for (const [model, r] of Object.entries(manifest.rides)) {
      const head = riderPoint(r, [0, 0, HEAD_Z]);
      const radius = (HEAD_R * r.rider) / r.scale;
      for (const part of geometry[model]!.parts) expect(boxDist(head, part), `${model}: head in ${part.n}`).toBeGreaterThan(radius);
    }
  });
  it('closed cars: the whole head is above the roof', () => {
    for (const [model, g] of Object.entries(geometry)) {
      if (!g.parts.some((p) => p.n.includes('cabin'))) continue;
      const r = manifest.rides[model]!;
      const chin = riderPoint(r, [0, 0, HEAD_Z])[2] - (HEAD_R * r.rider) / r.scale;
      const roof = Math.max(...g.parts.map((p) => p.max[2]!));
      expect(chin, model).toBeGreaterThan(roof);
    }
  });
  it('every wheel is attached to the body (part boxes touch, transitively)', () => {
    const tol = 0.006;
    for (const [model, g] of Object.entries(geometry)) {
      const touch = (a: (typeof g.parts)[0], b: (typeof g.parts)[0]) => [0, 1, 2].every((i) => a.min[i]! - tol <= b.max[i]! && b.min[i]! - tol <= a.max[i]!);
      const vol = (p: (typeof g.parts)[0]) => p.max.reduce((s, v, i) => s * (v - p.min[i]!), 1);
      const start = g.parts.reduce((a, b) => (vol(b) > vol(a) ? b : a));
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const a = queue.pop()!;
        for (const b of g.parts) {
          if (seen.has(b) || !touch(a, b)) continue;
          seen.add(b);
          queue.push(b);
        }
      }
      const loose = g.parts.filter((p) => !seen.has(p)).map((p) => p.n);
      expect(loose.filter((n) => n.includes('tyre')), `${model}: floating wheels`).toEqual([]);
      expect(loose, `${model}: floating parts`).toEqual([]);
    }
  });
  it('hands hold the grips on bar rides', () => {
    for (const [model, g] of Object.entries(geometry)) {
      if (!g.grips) continue;
      const r = manifest.rides[model]!;
      ([-1, 1] as const).forEach((side, i) => {
        const d = Math.hypot(...handOf(r, side).map((v, j) => v - g.grips![i]![j]!));
        expect(d, `${model} hand ${side}`).toBeLessThan(0.005);
      });
    }
  });
});

describe('normalizeAvatar (looks from peers on other versions)', () => {
  it('keeps an older look that predates the shoe/hat/glasses/extra colours', () => {
    const old = { body: 'broad', skin: '#5E3A26', hair: 'afro', hairColor: '#1F1A17', face: 'grin', top: 'tank', topColor: '#FF6B6B', bottom: 'cargo', bottomColor: '#1F2937', shoes: 'boots', hat: 'cap', glasses: 'shades', accessory: 'cape' };
    const n = normalizeAvatar(old);
    expect(n).toMatchObject(old);
    expect(n.shoeColor).toBe(DEFAULT_AVATAR.shoeColor);
    expect(n.extraColor).toBe(DEFAULT_AVATAR.extraColor);
  });
  it('maps part ids this build does not know to the default, field by field', () => {
    const n = normalizeAvatar({ ...DEFAULT_AVATAR, hair: 'hologram', hat: 'wizard' });
    expect(n.hair).toBe(DEFAULT_AVATAR.hair);
    expect(n.hat).toBe('wizard');
  });
});
