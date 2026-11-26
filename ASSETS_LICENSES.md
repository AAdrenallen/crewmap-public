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
| Waze alerts | waze.com Live Map (runtime, not bundled) | Shown with "Waze" attribution; see docs/RESEARCH.md |
| App icon, adaptive icon, splash, favicon | Rendered from the avatar kit by `tools/blender/icon.py` | Original work |

No third-party 3D assets (Kenney/Quaternius) are used; if added later, list them here with their CC0 licence.
