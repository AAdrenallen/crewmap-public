import { describe, expect, it } from 'vitest';
import { angleDiffDeg, destination, haversineM } from '../src/geo';
import { BearingSelector, COMPASS, CompassFilter, MotionSmoother, SELF_MOTION } from '../src/motion';

const A = { lat: 45.65, lng: -74.33 };

describe('MotionSmoother', () => {
  it('extrapolates along course and caps past maxExtrapolateMs', () => {
    const m = new MotionSmoother();
    m.push({ t: 0, ...A, speed: 10, heading: 90 });
    expect(haversineM(m.sample(1000)!, destination(A, 90, 10))).toBeLessThan(0.1);
    const capped = haversineM(A, m.sample(10_000)!);
    expect(capped).toBeCloseTo(10 * SELF_MOTION.maxExtrapolateMs / 1000, 1);
  });

  it('holds still below minSpeed', () => {
    const m = new MotionSmoother();
    m.push({ t: 0, ...A, speed: 0.5, heading: 90 });
    expect(haversineM(A, m.sample(1000)!)).toBe(0);
    expect(m.animating(500)).toBe(false);
  });

  it('blends a correction instead of snapping, and converges', () => {
    const m = new MotionSmoother();
    m.push({ t: 0, ...A, speed: 10, heading: 0 });
    const shown = m.sample(1000)!;
    const B = destination(destination(A, 0, 10), 90, 8); // the fix lands 8 m east of the prediction
    m.push({ t: 1000, ...B, speed: 10, heading: 0 }, 1000);
    expect(haversineM(m.sample(1000)!, shown)).toBeLessThan(0.01);
    const end = m.sample(1000 + SELF_MOTION.blendMs)!;
    expect(haversineM(end, destination(B, 0, 10 * SELF_MOTION.blendMs / 1000))).toBeLessThan(0.1);
  });

  it('blends heading the short way round', () => {
    const m = new MotionSmoother();
    m.push({ t: 0, ...A, speed: 10, heading: 350 });
    m.push({ t: 1000, ...destination(A, 350, 10), speed: 10, heading: 10 }, 1000);
    const mid = m.sample(1000 + SELF_MOTION.blendMs / 4)!.heading!;
    expect(Math.abs(angleDiffDeg(0, mid))).toBeLessThan(15);
  });

  it('snaps on a teleport', () => {
    const m = new MotionSmoother();
    m.push({ t: 0, ...A, speed: 10, heading: 0 });
    const far = destination(A, 90, 2000);
    m.push({ t: 1000, ...far, speed: 10, heading: 0 }, 1000);
    expect(haversineM(m.sample(1000)!, far)).toBeLessThan(0.01);
  });
});

describe('CompassFilter', () => {
  it('low-passes across north the short way and throttles', () => {
    const c = new CompassFilter();
    expect(c.push(350, 0)).toBe(350);
    expect(c.push(10, 50)).toBeNull(); // < minIntervalMs
    const v = c.push(10, 300)!;
    expect(Math.abs(angleDiffDeg(350, v))).toBeLessThan(20);
    expect(angleDiffDeg(350, v)).toBeGreaterThan(0);
  });
  it('drops changes under minStepDeg', () => {
    const c = new CompassFilter();
    c.push(100, 0);
    expect(c.push(101, 1000)).toBeNull();
    expect(c.push(120, 2000)).not.toBeNull();
  });
});

describe('BearingSelector', () => {
  it('compass when stopped, course when moving, with hysteresis', () => {
    const s = new BearingSelector();
    expect(s.bearing(0, 90, 10, 0)).toBe(10);
    expect(s.source).toBe('compass');
    s.bearing(2, 90, 10, 1000);
    expect(s.source).toBe('compass'); // below onMps
    s.bearing(5, 90, 10, 2000);
    expect(s.source).toBe('course');
    s.bearing(2, 90, 10, 3000);
    expect(s.source).toBe('course'); // above offMps
    s.bearing(1, 90, 10, 4000);
    expect(s.source).toBe('compass');
  });
  it('cross-fades at a switch', () => {
    const s = new BearingSelector();
    s.bearing(0, 90, 10, 0);
    const mid = s.bearing(5, 90, 10, 1000 + COMPASS.blendMs / 2)!; // switch at this call: starts at 10
    expect(mid).toBeCloseTo(10, 5);
    const half = s.bearing(5, 90, 10, 1000 + COMPASS.blendMs)!;
    expect(half).toBeGreaterThan(10);
    expect(half).toBeLessThan(90);
    expect(s.bearing(5, 90, 10, 10_000)).toBe(90);
    expect(s.blending(10_000)).toBe(false);
  });
});

describe('MotionSmoother track matching window', () => {
  it('still matches after a jump far beyond the local search window', () => {
    const geometry = Array.from({ length: 2000 }, (_, i) => destination(A, 90, i * 10));
    const cum = geometry.map((_, i) => i * 10);
    const m = new MotionSmoother(SELF_MOTION);
    m.setTrack({ geometry, cum });
    m.push({ t: 1000, ...geometry[10]!, speed: 20, heading: 90 });
    m.push({ t: 2000, ...geometry[1500]!, speed: 20, heading: 90 });
    const p = m.predict(2000)!;
    expect(haversineM(p, geometry[1500]!)).toBeLessThan(15);
  });
});
