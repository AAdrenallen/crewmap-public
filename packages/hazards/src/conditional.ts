import type { HttpGet } from './types';

/**
 * Conditional GET for official feeds: remembers each URL's ETag / Last-Modified and body; a 304 answer is served
 * from that body, so an unchanged feed costs the server (and the radio) a header exchange only. Bounded LRU.
 */
export function withConditionalGet(http: HttpGet, maxEntries = 64): HttpGet {
  const cache = new Map<string, { etag: string | null; lastModified: string | null; body: string }>();
  return async (url, headers) => {
    const c = cache.get(url);
    const h: Record<string, string> = { ...(headers ?? {}) };
    if (c?.etag) h['If-None-Match'] = c.etag;
    if (c?.lastModified) h['If-Modified-Since'] = c.lastModified;
    const res = await http(url, h);
    if (res.status === 304 && c) {
      cache.delete(url);
      cache.set(url, c);
      return { status: 200, json: async () => JSON.parse(c.body) as unknown, text: async () => c.body };
    }
    if (res.status !== 200) return res;
    const body = await res.text();
    const etag = res.headers?.get('etag') ?? null;
    const lastModified = res.headers?.get('last-modified') ?? null;
    if (etag || lastModified) {
      cache.delete(url);
      cache.set(url, { etag, lastModified, body });
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    }
    return { status: 200, headers: res.headers, json: async () => JSON.parse(body) as unknown, text: async () => body };
  };
}
