import type { FunctionName, TransportConfig } from './transport/types';

/** Section 2A switch rule: move a function to the PC only if P2P fails one of these. */
export const SWITCH_RULE = {
  maxExtraBatteryPct: 25,
  maxP95StalenessS: 60,
  minDeliveryRate: 0.98,
  deliveryWindowS: 30,
  /** "fps visibly drops": below this p10 frame rate on the map while the phase runs. */
  minP10Fps: 45,
} as const;

export interface PhaseResult {
  mode: 'baseline' | 'p2p' | 'relay';
  hours: number;
  /** Battery percentage points per hour (not charging). */
  drainPctPerHour: number;
  stalenessP50S: number | null;
  stalenessP95S: number | null;
  deliveries: number;
  deliveredWithin30s: number;
  deliveryP95S: number | null;
  fpsP10: number | null;
  memMb: number | null;
}

export interface BenchmarkReport {
  startedAt: number;
  endedAt: number;
  device: string;
  phases: PhaseResult[];
  extraBatteryPct: { p2p: number | null; relay: number | null };
  suggested: TransportConfig;
  reasons: Record<FunctionName, string>;
}

export function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

/**
 * Apply the switch rule. Battery extra = (phase drain − baseline drain) / baseline drain. A function moves to the
 * PC only when P2P fails a threshold AND the relay phase (if measured) does better on it.
 */
export function suggestConfig(phases: PhaseResult[]): Pick<BenchmarkReport, 'extraBatteryPct' | 'suggested' | 'reasons'> {
  const base = phases.find((p) => p.mode === 'baseline');
  const p2p = phases.find((p) => p.mode === 'p2p');
  const relay = phases.find((p) => p.mode === 'relay');
  const extra = (ph?: PhaseResult) => (base && ph && base.drainPctPerHour > 0 ? ((ph.drainPctPerHour - base.drainPctPerHour) / base.drainPctPerHour) * 100 : null);
  const e2 = extra(p2p);
  const er = extra(relay);
  const rate = (ph?: PhaseResult) => (ph && ph.deliveries > 0 ? ph.deliveredWithin30s / ph.deliveries : null);
  const suggested: TransportConfig = { presence: 'p2p', emotes: 'p2p', arrivals: 'p2p', sync: 'p2p', chores: 'p2p', wake: 'p2p' };
  const reasons = {} as Record<FunctionName, string>;
  const fns: FunctionName[] = ['presence', 'emotes', 'arrivals', 'sync', 'chores', 'wake'];
  for (const fn of fns) {
    const fails: string[] = [];
    if (e2 !== null && e2 > SWITCH_RULE.maxExtraBatteryPct) fails.push(`battery +${e2.toFixed(0)}%`);
    if (fn === 'presence' && p2p?.stalenessP95S != null && p2p.stalenessP95S > SWITCH_RULE.maxP95StalenessS) fails.push(`p95 staleness ${p2p.stalenessP95S.toFixed(0)} s`);
    if ((fn === 'emotes' || fn === 'arrivals' || fn === 'wake') && rate(p2p) !== null && rate(p2p)! < SWITCH_RULE.minDeliveryRate) fails.push(`delivery ${(rate(p2p)! * 100).toFixed(1)}%`);
    if (p2p?.fpsP10 != null && p2p.fpsP10 < SWITCH_RULE.minP10Fps) fails.push(`fps p10 ${p2p.fpsP10.toFixed(0)}`);
    const relayBetter =
      relay !== undefined &&
      ((er !== null && e2 !== null && er < e2) || (rate(relay) ?? 0) > (rate(p2p) ?? 1) || (relay.stalenessP95S ?? Infinity) < (p2p?.stalenessP95S ?? 0));
    if (fails.length > 0 && relayBetter) {
      suggested[fn] = 'relay';
      reasons[fn] = `P2P fails (${fails.join(', ')}); PC relay measured better`;
    } else if (fails.length > 0) {
      reasons[fn] = `P2P fails (${fails.join(', ')}) but no better relay measurement — keep P2P, run the relay phase`;
    } else {
      reasons[fn] = p2p ? 'P2P within all thresholds' : 'no P2P measurement yet (default P2P)';
    }
  }
  return { extraBatteryPct: { p2p: e2, relay: er }, suggested, reasons };
}

export function renderReport(r: BenchmarkReport): string {
  const f = (x: number | null, d = 1) => (x === null ? '—' : x.toFixed(d));
  const rows = r.phases
    .map((p) => `| ${p.mode} | ${p.hours.toFixed(1)} | ${f(p.drainPctPerHour, 2)} | ${f(p.stalenessP50S)} / ${f(p.stalenessP95S)} | ${p.deliveries ? `${((p.deliveredWithin30s / p.deliveries) * 100).toFixed(1)}% (${p.deliveredWithin30s}/${p.deliveries})` : '—'} | ${f(p.deliveryP95S)} | ${f(p.fpsP10, 0)} | ${f(p.memMb, 0)} |`)
    .join('\n');
  const cfg = (Object.keys(r.suggested) as FunctionName[]).map((k) => `| ${k} | ${r.suggested[k] === 'relay' ? '**PC relay**' : 'P2P'} | ${r.reasons[k]} |`).join('\n');
  return `## On-device benchmark — ${r.device}, ${new Date(r.startedAt).toISOString()}

| Phase | Hours | Drain %/h | Staleness p50/p95 (s) | Delivery ≤ 30 s | Delivery p95 (s) | fps p10 | JS heap MB |
|---|---|---|---|---|---|---|---|
${rows}

Extra battery vs baseline: P2P ${f(r.extraBatteryPct.p2p, 0)}%, relay ${f(r.extraBatteryPct.relay, 0)}%.

| Function | Suggested | Why |
|---|---|---|
${cfg}
`;
}
