import type { Clock } from '@crewmap/p2p';

interface Task {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/** Discrete-event virtual clock: hours of simulated time run in seconds of real time, deterministically. */
export class SimClock implements Clock {
  private t: number;
  private seq = 0;
  private heap: Task[] = [];

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): Task {
    const task: Task = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.push(task);
    return task;
  }

  clearTimeout(h: unknown): void {
    if (h && typeof h === 'object' && 'cancelled' in h) (h as Task).cancelled = true;
  }

  every(ms: number, fn: () => void, jitter: () => number = () => 0): void {
    const loop = () => {
      fn();
      this.setTimeout(loop, ms + jitter());
    };
    this.setTimeout(loop, ms + jitter());
  }

  /** Run all tasks up to `until` (inclusive). Promise callbacks are flushed between tasks. */
  async runUntil(until: number): Promise<void> {
    while (this.heap.length > 0 && this.heap[0]!.at <= until) {
      const task = this.pop()!;
      if (task.cancelled) continue;
      this.t = task.at;
      task.fn();
      // Let promise continuations (publish acks, async sends) settle at the same virtual instant.
      for (let i = 0; i < 4; i++) await Promise.resolve();
    }
    this.t = until;
  }

  private push(task: Task): void {
    const h = this.heap;
    h.push(task);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[p]!, h[i]!)) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  private pop(): Task | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }

  private less(a: Task, b: Task): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
}
