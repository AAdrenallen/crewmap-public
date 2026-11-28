import { useEffect, useState } from 'react';
import { WIKI, WikiPlaceInfo, type HttpGet, type WikiLang, type WikiSummary } from '@crewmap/hazards';
import { lang } from '@crewmap/shared/i18n';
import type { LatLng } from '@crewmap/shared/geo';
import { countRequest } from './apiBudget';
import { kvGet, kvSet } from './db';
import { useApp } from './store';

const http: HttpGet = async (url, headers) => {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: headers ?? {}, signal: ctl.signal });
    return { status: res.status, headers: res.headers, json: () => res.json(), text: () => res.text() };
  } finally {
    clearTimeout(to);
  }
};

export const wiki = new WikiPlaceInfo(http, () => countRequest('wiki'));

/** Cache key: ~100 m cell per language. */
const keyOf = (p: LatLng, l: WikiLang) => `wiki.${l}.${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;

/** Nearby Wikipedia article for a place (D70): device cache 30 days, one request on a miss while online. */
export function useWikiSummary(p: LatLng | null | undefined): WikiSummary | null {
  const [s, setS] = useState<WikiSummary | null>(null);
  const online = useApp((x) => x.online);
  const lat = p?.lat;
  const lng = p?.lng;
  useEffect(() => {
    if (lat === undefined || lng === undefined) return;
    let live = true;
    const l = lang() as WikiLang;
    const key = keyOf({ lat, lng }, l);
    void (async () => {
      const now = Date.now();
      const c = await kvGet<{ at: number; s: WikiSummary | null } | null>(key, null);
      if (c && now - c.at < WIKI.cacheMs) {
        if (live) setS(c.s);
        return;
      }
      if (!online) return;
      const got = await wiki.lookup({ lat, lng }, l, now);
      if (got === undefined) return;
      void kvSet(key, { at: now, s: got });
      if (live) setS(got);
    })();
    return () => {
      live = false;
    };
  }, [lat, lng, online]);
  return s;
}
