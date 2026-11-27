# Asset licences

| Asset | Source | Licence |
|---|---|---|
| Avatar kit `apps/mobile/assets/models/avatar.glb` | Modelled procedurally (lathed profiles, bevelled boxes, Bezier tubes, sculpted ellipsoids) by `tools/blender/build_assets.py` | Original work (project licence) |
| Cars `apps/mobile/assets/models/cars.glb` (8 incl. hot-dog car) | Same pipeline (profile-extruded bevelled bodies, rimmed wheels) | Original work |
| Sprite studio lighting environment | `RoomEnvironment` from three.js examples, generated at bake time (no bundled image) | MIT (three.js) |
| Emote jingles `apps/mobile/assets/emotes/*.wav` | Synthesised by `tools/sounds/gen.mjs` | Original work |
| Emote art | Hand-written SVG in `apps/mobile/src/ui/emotes/EmoteArt.tsx` | Original work |
| Maneuver arrows | SVG in `apps/mobile/src/ui/drive/NavBanners.tsx` | Original work |
| Map tiles, styles, terrain, traffic | Mapbox (runtime, not bundled) | Mapbox ToS; © Mapbox © OpenStreetMap contributors (attribution shown on the map) |
| Québec road works / events / photo radar | Données Québec / MTMD (runtime) | CC-BY 4.0 — attribution "Gouvernement du Québec (MTMD)" shown on hazards |
| Fixed speed / red-light cameras | OpenStreetMap via Overpass API (runtime, cached on device) | ODbL 1.0 — "© OpenStreetMap contributors, ODbL" shown on hazards |
| Fuel prices (regular / super / diesel, every Québec station) | Régie de l’énergie du Québec, Régie essence Québec public file `regieessencequebec.ca/stations.geojson.gz` (runtime, cached on device) | Official data published for download; no licence text published (see docs/DECISIONS.md D64) — "Régie de l’énergie du Québec" shown on each station |
| Traffic cameras (location + link to the Québec 511 viewer) | Données Québec / MTMD `ms:infos_cameras` (runtime) | CC-BY 4.0 — "Gouvernement du Québec (MTMD)" shown on each camera; images are not copied |
| Fuel stations and EV chargers | OpenStreetMap via Overpass API (runtime, cached on device) | ODbL 1.0 — "© OpenStreetMap contributors, ODbL" shown on each point |
| EV chargers (optional, only with a key) | Open Charge Map API (runtime) | Open-licence records only (CC BY 4.0 and other open licences); provider and licence shown per record |
| Waze alerts | waze.com Live Map (runtime, not bundled) | Shown with "Waze" attribution; see docs/RESEARCH.md |
| App icon, adaptive icon, splash, favicon | Rendered from the avatar kit by `tools/blender/icon.py` | Original work |

No third-party 3D assets (Kenney/Quaternius) are used; if added later, list them here with their CC0 licence.
