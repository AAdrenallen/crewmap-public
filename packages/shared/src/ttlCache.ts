/** Small LRU cache with a per-entry time-to-live (route results, search answers). Pure; time passed in. */
export class TtlCache<V> {
  private readonly map = new Map<string, { v: V; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string, now: number): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs || now < e.at) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order (not the age: the data is as old as when it was fetched).
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V, now: number): void {
    this.map.delete(key);
    this.map.set(key, { v, at: now });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
