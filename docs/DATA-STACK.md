# Data stack: traffic, incidents, map, battery (2026-11-24)

Items marked *(verify)* were not re-checked live in this pass.

## Recommended stack
- **Incidents/works/closures:** MTMD WFS (Québec 511 data) + Montréal CKAN entraves. Both are open data under CC-BY 4.0 and cost nothing.
- **Traffic + route incidents:** Mapbox Directions `driving-traffic` (`incidents[]`, congestion), called only when routing.
- **Police/hazards:** friend reports through the existing P2P layer. Waze stays as an honest, health-checked adapter (often 403).
- **Map:** keep Mapbox Standard 3D. The free tier is far above our use. The wordmark is mandatory, and MapLibre + OpenFreeMap is the fallback.
- **Battery:** a tiered Fused Location Provider (FLP) driven by Activity Recognition transitions. High accuracy only while driving or navigating. Network calls batched.

## Québec data sources
| Source | Content | Format | Licence | Freshness |
|---|---|---|---|---|
| MTMD WFS `ws.mapserver.transports.gouv.qc.ca/swtq` | `ms:evenements` (closures/incidents = the Québec 511 feed), `ms:chantiers_mtmdet` (works), `ms:conditions_routieres` (winter conditions), `ms:radars_photos` | WFS 2.0, `outputformat=geojson`, `bbox=` | CC-BY 4.0 | "continuous", stamps within hours |
| Données Québec "Travaux routiers" | same endpoint (GeoJSON/CSV/WFS) | — | CC-BY 4.0 | continuous |
| Montréal "Entraves et travaux en cours" (`donnees.montreal.ca`, CKAN `datastore_search`) | permits + street impacts | JSON / CSV | CC-BY 4.0 | daily (~07:00 UTC) |
| Ville-Centre / Québec City / Gatineau open data portals *(verify)* | mostly static road works; no real-time incident APIs found | CSV/GeoJSON | mostly CC-BY 4.0 | weekly to daily |

Québec 511 has no public developer API of its own. Its data comes from the same MTMD WFS. [Québec 511 FAQ](https://www.quebec511.info/en/quebec511/faq.asp)

**Road511** is an aggregator. Its only free option is a 14-day trial (1,000 requests/day, 2 jurisdictions); after that it costs US$29/month. It is not worth it, because MTMD already gives us the same Québec data. [publicapis.dev](https://publicapis.dev/resource/road511/gvaa83xo)

**How to poll the feeds:**
- Fetch only the route or viewport bbox, padded by 10–20 km. Never fetch the whole province.
- Send `If-None-Match` / `If-Modified-Since` and treat a 304 as free. Where the server sends no validators, hash the body.
- Intervals:
  - MTMD events: every 5 min while driving, 15 min while the app is open, never while idle.
  - Works and conditions: every 15–30 min.
  - Montréal: every 6 h, since the source updates daily. Re-check schedules locally.
- Piggyback these fetches on wake-ups that are already happening, such as location batches and P2P sync. One phone in the crew can fetch and share a feed over P2P.

## Map display
**Mapbox (Nov 2026):**
- Free per month: 25k mobile MAU, 100k Directions requests, 100k Matrix elements, 100k Map Matching requests, and Search Box at 25k requests or 2.5k sessions. ([pricing](https://www.mapbox.com/pricing), RESEARCH.md)
- Under 20 users is under 1% of the MAU limit.
- The **wordmark and attribution are required**. Their position and colours can be adjusted, but they cannot be removed or restyled. On Android, the SDK adds the logo and an (i) button that opens the attribution sheet. [attribution docs](https://docs.mapbox.com/help/dive-deeper/attribution/), [FAQ](https://docs.mapbox.com/help/faq/what-type-of-attribution-is-required)

**Alternatives.** OpenStreetMap data (ODbL) always needs "© OpenStreetMap" credit somewhere visible, but a small (i) button that opens an info sheet is acceptable.
- **MapLibre Native + OpenFreeMap:** free with no key and no logo. Attribution is text only and added automatically. It has 3D extrusions but no terrain, and it is a best-effort service. [openfreemap.org](https://openfreemap.org)
- **Protomaps PMTiles, self-hosted:** a single file on the relay PC or any static host. No logo, OSM credit only. Cleanest long-term option.
- **MapTiler free:** non-commercial only, with tile quotas. The free plan requires the MapTiler logo. It has terrain and 3D. [MapTiler attribution](https://docs.maptiler.com/guides/map-design/attribution/add-attribution/)
- **Stadia:** free for non-commercial use with credit quotas. Text attribution is required. [stadiamaps.com/attribution](https://stadiamaps.com/attribution/)
- **Thunderforest:** a free hobby tier exists, but its styles are raster-first and look dated.
- **TomTom and HERE:** each has a daily or monthly free tier, a logo/attribution requirement and a key *(verify current quotas)*. Their traffic flow tiles are their only advantage.

**Verdict:**
- Stay on Mapbox. Its Standard 3D style (buildings, terrain, light presets) is unmatched for free, and the logo is small.
- If the logo or the vendor lock-in becomes a problem, switch to MapLibre + self-hosted Protomaps (or OpenFreeMap), with OSM credit in an info sheet. That route has no Standard-grade 3D landmarks and only basic extrusions.

## Hybrid data flow
1. While driving, the phone pulls MTMD and Montréal data for its bbox (cached with ETag).
2. If navigating, Mapbox `driving-traffic` returns the route, congestion and `incidents[]`. No separate traffic polling is needed.
3. Friends' reports (police, hazard) and passive speed segments travel as small E2E-encrypted Yjs/ephemeral messages.
4. The existing hazards package merges and dedupes everything by type, distance and time, with TTLs. Priority: friend (fresh) > official > Mapbox > Waze.
5. Don't add TomTom/HERE traffic unless Mapbox congestion proves insufficient.

## Battery checklist
Fused Location Provider (FLP) settings by state:

| State | Priority | Interval | `minUpdateDistance` | `maxUpdateDelay` |
|---|---|---|---|---|
| Idle / still | no location requests | — | — | — |
| Walking / moving | `PRIORITY_BALANCED_POWER_ACCURACY` | 60–120 s | 50–100 m | 5–10 min (batched) |
| Driving, not navigating | `PRIORITY_HIGH_ACCURACY` | 5–10 s | 20 m | 30–60 s |
| Active navigation | `PRIORITY_HIGH_ACCURACY` | 1 s | 0 | 0 |

- While idle or still, rely on `PRIORITY_PASSIVE` plus geofences for places. Activity Recognition `STILL → IN_VEHICLE` transitions switch between tiers. [FLP](https://developer.android.com/develop/sensors-and-location/location/request-updates), [Transition API](https://developer.android.com/develop/sensors-and-location/location/transitions), [batching](https://developer.android.com/develop/sensors-and-location/location/battery)
- Geofencing: `GeofencingClient` for arrivals, with ≥ 100–150 m radius and a responsiveness of 2–5 min.
- Use `foregroundServiceType="location"` only while sharing live. Let the phone Doze otherwise, and use ntfy/high-priority FCM-free wake-ups only for content-free pings.
- Radio tail: one LTE request keeps the radio in high power for about 10 s. Coalesce location upload, feed poll and sync into one burst. Never poll on a timer while the screen is off.
- Throttle the map: lower fps when the screen is off or the map is idle. Telemetry is already off. Prefetch tiles on Wi-Fi.

## Google Maps grey-area verdict: **No**
- Google's terms forbid scraping or extracting content outside the APIs. [Maps Platform ToS](https://cloud.google.com/maps-platform/terms), [Google ToS](https://policies.google.com/terms)
- Unofficial endpoints are undocumented and obfuscated, and they change without notice. They sit behind bot detection (the same edge that now 403s Waze Live Map), so IP or account blocks are likely.
- Polling them in the background would also cost battery.
- No Google API, official or not, exposes the police or user reports.
- Intents only open the Maps app; they return no data.
- Legitimate paths:
  - the Notification Access ETA reader (D25)
  - Mapbox traffic
  - official open data
  - friend reports
  - the Google Routes API free tier, for traffic-aware ETA only (no incidents)

## Already in CrewMap vs. recommended changes
- Done: MTMD WFS (events, works, radars) with bbox. Montréal CKAN every 6 h. Mapbox `driving-traffic` incidents. Merge/dedupe. Friend reports. Waze adapter with kill switch. Notification ETA reader. Mapbox telemetry off.
- New: add `ms:conditions_routieres` (winter conditions) to the hazards layer if it isn't rendered yet.
- New: conditional GET (ETag/Last-Modified, or a body hash) on every feed, and state-based polling intervals as above.
- New: one fetcher per crew shares each feed over P2P, so the other phones don't fetch it.
- New: audit the FLP tiers against the table, especially `maxUpdateDelay` batching outside driving and passive mode while still.
- New: coalesce all network work into a single radio burst per location batch.
- Optional: a MapLibre + Protomaps fallback style kept behind config (no Mapbox logo or lock-in).
- Don't: Google scraping, Road511, or paid traffic APIs.
