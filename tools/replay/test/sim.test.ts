import { describe, expect, it } from 'vitest';
import { runScenario } from '../src/sim/scenarios';

describe('X5 multi-peer simulator', () => {
  it('P2P: presence, emotes and arrivals reach peers incl. backgrounded ones (20-min drive)', async () => {
    const r = await runScenario({ name: 'drive-1h', mode: 'p2p', durationMin: 20 });
    expect(r.staleness!.samples).toBeGreaterThan(1000);
    expect(r.staleness!.p95S).toBeLessThan(60);
    expect(r.emotes.sent).toBeGreaterThanOrEqual(9);
    expect(r.emotes.rate).toBeGreaterThanOrEqual(0.9);
    expect(r.arrivals.sent).toBeGreaterThanOrEqual(1);
    expect(r.wakePings).toBeGreaterThan(0);
  });

  it('relay mode carries the same traffic through the PC relay only', async () => {
    const r = await runScenario({ name: 'drive-1h', mode: 'relay', durationMin: 10 });
    expect(r.staleness!.p95S).toBeLessThan(60);
    expect(r.emotes.rate).toBeGreaterThanOrEqual(0.9);
  });
});
