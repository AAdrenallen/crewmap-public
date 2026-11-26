import { describe, expect, it } from 'vitest';
import { renderReport, suggestConfig, type PhaseResult } from '../src/benchmark';

const phase = (p: Partial<PhaseResult> & Pick<PhaseResult, 'mode'>): PhaseResult => ({
  hours: 2, drainPctPerHour: 1, stalenessP50S: 4, stalenessP95S: 8, deliveries: 100, deliveredWithin30s: 100, deliveryP95S: 6, fpsP10: 58, memMb: 120, ...p,
});

describe('X6 benchmark switch rule', () => {
  it('keeps P2P when within thresholds', () => {
    const r = suggestConfig([phase({ mode: 'baseline', drainPctPerHour: 1.0 }), phase({ mode: 'p2p', drainPctPerHour: 1.2 })]);
    expect(Object.values(r.suggested).every((m) => m === 'p2p')).toBe(true);
    expect(r.extraBatteryPct.p2p).toBeCloseTo(20);
  });
  it('moves emotes/arrivals to the PC when P2P delivery < 98% and the relay does better', () => {
    const r = suggestConfig([
      phase({ mode: 'baseline', drainPctPerHour: 1 }),
      phase({ mode: 'p2p', drainPctPerHour: 1.1, deliveredWithin30s: 90 }),
      phase({ mode: 'relay', drainPctPerHour: 1.1, deliveredWithin30s: 100 }),
    ]);
    expect(r.suggested.emotes).toBe('relay');
    expect(r.suggested.arrivals).toBe('relay');
    expect(r.suggested.presence).toBe('p2p');
  });
  it('does not move anything without a better relay measurement', () => {
    const r = suggestConfig([phase({ mode: 'baseline', drainPctPerHour: 1 }), phase({ mode: 'p2p', drainPctPerHour: 1.6 })]);
    expect(Object.values(r.suggested).every((m) => m === 'p2p')).toBe(true);
    expect(r.reasons.presence).toMatch(/battery \+60%/);
    expect(renderReport({ startedAt: 0, endedAt: 1, device: 'test', phases: [], ...r })).toContain('| presence | P2P |');
  });
});
