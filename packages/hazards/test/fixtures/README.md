# Hazard fixtures
- `qc-*.json` — **recorded** responses from the MTMD WFS (2026-11-23, `count=2`), CC-BY 4.0.
- `waze-a15-city.json` — Waze Live Map response **in the documented shape** used by public projects
  (`alerts[]` with uuid/type/subtype/location{x,y}/pubMillis/reliability/nThumbsUp/magvar, `jams[]` with line/level).
  It is not a live recording: automated requests to the endpoint were blocked from this machine during Phase 0
  (see docs/RESEARCH.md). Replace it with a real capture via `pnpm --filter @crewmap/hazards capture:waze` when a
  live request succeeds; the contract test then runs against the real shape.
- `qc-chantiers-north.json`, `qc-evenements-live.json` — **recorded** 2026-11-24 from the MTMD WFS (bbox around
  Val-Clair / A-50 / R-148 / A-640; events province-wide, one per entrave kind), CC-BY 4.0.
- `mtl-permits.json`, `mtl-impacts.json` — **recorded** 2026-11-24 from the Ville de Montréal CKAN datastore
  ("Entraves et travaux en cours", CC-BY 4.0), 7 permits covering street-closed / lane / parking-only impacts.
- `qc-inondation.json`, `qc-conditions.json` — **recorded** 2026-11-24 from the MTMD WFS layers `ms:evenements_inondation`
  and `ms:conditions_routieres` (trimmed to 2 segments, 4 vertices each), CC-BY 4.0. Both recorded segments were
  "Dégagée et sèche" / good visibility; the test flips one to a snow code to exercise the non-normal path.
