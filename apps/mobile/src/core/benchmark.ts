import { platform } from '@crewmap/platform';
import { pct, renderReport, suggestConfig, utf8, type BenchmarkReport, type PhaseResult } from '@crewmap/p2p';
import * as db from './db';
import { engine } from './engine';
import { useApp } from './store';

type Mode = PhaseResult['mode'];

interface Sample {
  t: number;
  battery: number;
  charging: boolean;
  staleness: number[];
  fps: number | null;
  memMb: number | null;
}

/**
 * On-device transport benchmark (Section 2A). Phases: baseline (sharing + network paused, only a minimal location
 * service keeps the process alive to measure), P2P (normal operation), and PC relay (if a relay URL is set).
 * Measures battery drain, staleness of friends' positions, delivery of acked probes to friends' (often backgrounded)
 * phones within 30 s, frame rate and JS heap. Produces a report and a suggested per-function config.
 */
class Benchmark {
  running = false;
  phase: Mode | null = null;
  private samples: Record<Mode, Sample[]> = { baseline: [], p2p: [], relay: [] };
  private deliveries: Record<Mode, { ok: boolean; s: number }[]> = { baseline: [], p2p: [], relay: [] };
  private timers: ReturnType<typeof setInterval>[] = [];
  private frames = 0;
  private fpsWindow: number | null = null;
  private rafId: number | null = null;
  private listeners = new Set<() => void>();

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  async run(totalHours: number): Promise<BenchmarkReport> {
    if (this.running) throw new Error('already running');
    this.running = true;
    const startedAt = Date.now();
    const withRelay = useApp.getState().settings.pcRelayUrl !== '';
    const modes: Mode[] = withRelay ? ['baseline', 'p2p', 'relay'] : ['baseline', 'p2p'];
    const phaseMs = (totalHours * 3600_000) / modes.length;
    const original = useApp.getState().settings.transport;
    engine.net.router?.onDelivery((d) => {
      if (d.kind === 'bench' && this.phase) this.deliveries[this.phase].push({ ok: d.ok, s: d.latencyMs / 1000 });
    });
    this.startFps();
    try {
      for (const m of modes) {
        this.phase = m;
        this.emit();
        await this.enter(m);
        await this.sampleFor(phaseMs, m);
      }
    } finally {
      this.stopFps();
      await engine.saveSettings({ transport: original });
      await engine.run();
      this.phase = null;
      this.running = false;
      this.emit();
    }
    const phases = modes.map((m) => this.summarise(m, phaseMs / 3600_000));
    const report: BenchmarkReport = {
      startedAt,
      endedAt: Date.now(),
      device: `${platform.power.device().manufacturer} ${platform.power.device().model} (Android ${platform.power.device().release})`,
      phases,
      ...suggestConfig(phases),
    };
    await db.kvSet('benchReport', report);
    return report;
  }

  async lastReport(): Promise<{ report: BenchmarkReport; markdown: string } | null> {
    const r = await db.kvGet<BenchmarkReport | null>('benchReport', null);
    return r ? { report: r, markdown: renderReport(r) } : null;
  }

  private async enter(m: Mode): Promise<void> {
    if (m === 'baseline') {
      engine.hazards.stop();
      engine.net.stop();
      await engine.tracking.stop();
      await platform.location.startBackground('still', { title: 'CrewMap', body: 'Benchmark' });
      return;
    }
    const all = m === 'relay' ? 'relay' : 'p2p';
    await engine.saveSettings({ transport: { presence: all, emotes: all, arrivals: all, sync: all, chores: all, wake: all } });
    await engine.restartForBenchmark();
  }

  private sampleFor(ms: number, m: Mode): Promise<void> {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = async () => {
        const b = await platform.power.battery();
        const now = Date.now();
        const st = useApp.getState();
        // Staleness of a driving friend's position as seen here.
        const staleness = Object.values(st.friends)
          .map((f) => f.presence)
          .filter((p): p is NonNullable<typeof p> => !!p && p.act === 'automotive' && now - p.t < 10 * 60_000)
          .map((p) => (now - p.t) / 1000);
        const hermes = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => { js_heapSize?: number } } }).HermesInternal;
        const heap = hermes?.getInstrumentedStats?.().js_heapSize;
        const s: Sample = { t: now, battery: b.level, charging: b.charging, staleness, fps: this.fpsWindow, memMb: heap ? heap / 1e6 : null };
        this.samples[m].push(s);
        await db.benchAppend(m, now, s);
        this.emit();
      };
      const probe = () => {
        if (m === 'baseline' || !engine.net.router) return;
        for (const f of Object.values(useApp.getState().friends)) {
          if (f.presence && Date.now() - f.presence.t < 30 * 60_000) void engine.net.router.sendTo(f.profile.deviceId, 'bench', utf8('probe'));
        }
      };
      void tick();
      this.timers.push(setInterval(() => void tick(), 60_000), setInterval(probe, 120_000));
      const done = setInterval(() => {
        if (Date.now() < end) return;
        for (const tm of this.timers) clearInterval(tm);
        this.timers = [];
        clearInterval(done);
        resolve();
      }, 5000);
    });
  }

  private summarise(m: Mode, hours: number): PhaseResult {
    const s = this.samples[m].filter((x) => !x.charging);
    const first = s[0];
    const last = s[s.length - 1];
    const h = first && last ? (last.t - first.t) / 3600_000 : 0;
    const d = this.deliveries[m];
    const fps = s.map((x) => x.fps).filter((x): x is number => x !== null);
    const mem = s.map((x) => x.memMb).filter((x): x is number => x !== null);
    const st = s.flatMap((x) => x.staleness);
    return {
      mode: m,
      hours,
      drainPctPerHour: first && last && h > 0 ? (first.battery - last.battery) / h : 0,
      stalenessP50S: pct(st, 50),
      stalenessP95S: pct(st, 95),
      deliveries: d.length,
      deliveredWithin30s: d.filter((x) => x.ok && x.s <= 30).length,
      deliveryP95S: pct(d.filter((x) => x.ok).map((x) => x.s), 95),
      fpsP10: pct(fps, 10),
      memMb: mem.length ? Math.max(...mem) : null,
    };
  }

  /** Counts frames while the app is in the foreground (null when backgrounded). */
  private startFps(): void {
    let windowStart = Date.now();
    const loop = () => {
      this.frames++;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        this.fpsWindow = (this.frames * 1000) / (now - windowStart);
        this.frames = 0;
        windowStart = now;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopFps(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }
}

export const benchmark = new Benchmark();
