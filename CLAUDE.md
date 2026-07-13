# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL, no build step, no npm) on GitHub Pages, a Python ETL pipeline that produces `plumes.bin`, and an offline research agent — the sibling **ch4id** repo (`~/Tools/ch4id`) — that produces `attributions.parquet`. Attribution is served entirely from that static dataset — there is no backend service any more (the old `firedamp-api` Cloudflare Worker + D1 vision pipeline was removed, and the original in-repo `agent/` pipeline moved to ch4id).

- The ch4id feature catalogue FlatGeobuf (`features.fgb`) served from GCS (`gs://firedamp-data/`). (The old OGIM PMTiles layer + toggle were removed 2026-07; the GCS object remains but nothing reads it.)
- `plumes.bin` lives in the `latest-data` GitHub Release, not in git.

## Plume sources

- **Carbon Mapper** — satellite + aircraft hyperspectral (API → `data/carbon_mapper.csv`)
- **IMEO / MARS** — UNEP methane plume database (Eye on Methane v2 API → `data/imeo_plumes.csv`)
- **SRON** — TROPOMI weekly plume CSVs (FTP scrape → `data/sron/` → `data/sron_all.csv`)
- **ch4id feature catalogue** — OGIM + OSM + MapStand + GEM merged (`~/Tools/ch4id/data/features.parquet`, ~15M features; ~12M exported as points)

## ETL

```
make data             # CM + SRON + IMEO → web/data/plumes.bin
make features         # ch4id features.parquet → web/data/features.fgb (duckdb spatial)
make features-upload  # FlatGeobuf → GCS
make rebuild          # data + features + upload
```

IMEO needs `IMEO_API_KEY` (request from unep-methanedata@un.org; set as a repo secret for CI). The whole `methanedata.unep.org` host is behind a Cloudflare managed challenge that fingerprints the TLS handshake, so `fetch_imeo.py` uses `curl_cffi` (Chrome JA3 impersonation) — plain httpx/requests/curl are blocked even with the key. Without a key it keeps any existing `data/imeo_plumes.csv` (manual fallback).

## Binary formats

**plumes.bin (`FDP1`)** — 20 bytes per plume + satellite name table + ID block.
- Header: `FDP1` magic, plume count (u32), satellite table.
- Record: lat(f32), lon(f32), days-since-2020(u16), rate_kg/hr(u32), unc(u32), src|sec(u8), sat_idx(u8).
- Footer: newline-separated plume IDs (SRON uses `display_id|source_file` composite; the frontend strips the suffix, so the plume's public id is the display id).

**attributions.bin (`FDA2`)** — built from `web/data/attributions.parquet` by `scripts/build_attr.py` (a uv script; dist.sh runs it in both deploy workflows). Header: `FDA2` magic, count (u32), model name table. Record: kind|confidence (u8), run_at days-since-2020 (u16), model idx (u8), coords-flag|verified (u8: bit 2 = assessed source point present, low 2 bits = confirmed/refuted/unclear/absent), optional lat+lon (2×f32), then 8 varint-length UTF-8 strings (plume id, source_label, source_name, operator, `\x1f`-joined attributed ids, paragraph, `\x1f`-joined evidence URLs, verify_notes). Parser mirror lives in `web/analysis.js`. Keys are **display ids** (no `|source_file` suffix) so they match frontend plume ids and survive SRON re-issuing weekly files under new version names.

## Plume attribution (frontend)

The detail panel serves source attribution **solely** from the bulk agentic dataset (`data/attributions.bin`, the `FDA2` binary above). `web/analysis.js` looks the plume up by id and renders `source_label` (an osm.org link for `OSM:` refs, otherwise a fly-to-feature link), `confidence`, a verification badge (verified/disputed, verify_notes in the tooltip), `paragraph` and `evidence` links; a plume with no record shows "No source attribution yet." Daily-mean surface wind (Open-Meteo archive) is still fetched per plume as an independent panel stat, unrelated to attribution.

**Candidate sources** (`web/sources.js`) render on the map from FlatGeobuf bbox queries (HTTP range requests, vendored `flatgeobuf-geojson.min.js`) against `gs://firedamp-data/features.fgb` — the ch4id feature catalogue (OGIM + OSM + MapStand + GEM, `make features` / `make features-upload`) as **points only**: geometries collapse to the catalogue's representative lat/lon, and pipelines/fields/licence areas are excluded (a point stands them nowhere sensible — so pipeline/field attributions get no map highlight). The export (`scripts/features.sql`) also joins a per-source `detail` string from the raw ch4id source tables (OGIM fac_type/admin area/spud year, OSM secondary tags, GEM technology/capacity/start year/country, MapStand well type/admin area) for the hover tooltip. Two query paths share one geojson source: (1) an optimistic viewport sweep on every `moveend` past zoom 13 (padded rect, so small pans don't refetch; cleared below the threshold), and (2) a per-plume radius query on selection — 3 km, 10 km for coarse sensors (TROPOMI/VIIRS/GOES/S3) — showing the nearest 300 within radius with the attributed feature(s) highlighted in amber (attributed ids always kept; the rect is stretched to cover the record's assessed source point). Candidates draw as white `×` glyphs (amber and larger when attributed) over an invisible fat circle layer (`src-hit`, r12) that carries the hover/click tooltip so targets are easy to hit. There is no nearby-list in the detail panel — candidates live on the map only (hover for details). ch4id feature ids use the short OSM form (`OSM:w<id>`); older attributions carry `OSM:way/<id>`, so `normId` normalises before matching. Selection highlight clears on panel close via `cancelAnalysis()` → `clearSelection()`; the viewport sweep persists. This replaced the OGIM PMTiles layer/toggle and Overpass-era nearby-infra list entirely (ogim.js, pmtiles vendor and the pmtiles protocol registration are gone).

There is **no in-browser vision/LLM pipeline** any more. The old on-demand path — Overpass + Nominatim + Open-Meteo + an annotated Esri map (`captureAnnotatedMap`) sent to the Worker → OpenRouter, with a `↻` regenerate button and a D1 peek cache — was removed (git history has it). `attributions.parquet`, committed to git and refreshed by the sibling **ch4id** repo's pipeline (`make deploy` there exports, commits and pushes it; update-data.yml only touches plumes), is the single source of truth; the site ships only the derived `attributions.bin` (gitignored, rebuilt by dist.sh at deploy time), fetched with the same `?v=<sha>` cache-busting as the JS so a Pages/CDN edge never serves a stale dataset against new code.

The attribution set also drives map styling: `app.js` loads it (via `loadAttributions()` in `analysis.js`), and `addPlumeLayers` gives every plume whose id is in the set a semi-transparent fill in its source colour (`circle-opacity` case on an `attr` property) so attributed plumes read as filled discs against the hollow rings of the rest.

## Frontend

ES modules, no build step. Key files:
- `web/app.js` — entry point: data load, layer assembly, UI wiring.
- `web/map.js` — map instance + basemap style.
- `web/plumes.js` — binary parser, plume layers, filters.
- `web/sources.js` — candidate sources from the ch4id catalogue (features.fgb): viewport sweep + per-plume selection.
- `web/detail.js` — detail panel, permalinks, overlap nav, interactions.
- `web/analysis.js` — static attribution lookup/render + wind stat.
- `web/util.js` — geometry + formatting helpers.
- `web/style.css` — glass-morphism dark UI, CMY source colours.

### URL scheme

- `#map=<zoom>/<lat>/<lon>` — MapLibre-managed.
- `#plume=<id>` — plume permalink (position derived from data).

### Overlap navigation

When multiple plumes share a location, the detail panel shows prev/next arrows to cycle.

## Development

```
make vendor        # MapLibre, FlatGeobuf, Inter font
make serve         # dev server on :8000 (HTTP Range for FlatGeobuf)
```

## Deployment

- **Pages**: push to `main` runs `deploy.yml`. Pulls `plumes.bin` from the `latest-data` Release, copies `web/*` into `dist/`, cache-busts JS/CSS with the git SHA, and deploys.
- **Plumes refresh**: `update-data.yml` runs every 6h (00:00/06:00/12:00/18:00 UTC), rebuilds `plumes.bin`, uploads to the Release, and redeploys Pages. Carbon Mapper publishes in sub-daily batches so it's polled often; SRON (weekly) and IMEO (irregular) don't gain much from the higher cadence but ride along.
- **Private deploy**: `make deploy-private` — builds `plumes.bin` locally (pulling in the local-only, gitignored `data/ghgsat.csv`) and pushes the site to Cloudflare Pages project `firedamp-private` (`https://firedamp-private.pages.dev`), which sits behind Cloudflare Access (Zero Trust app "Firedamp private", "Data Desk" policy = the three datadesk.eco emails, covering prod + `*.pages.dev` previews). This is the **only** deploy that ever contains GHGSat: the target refuses to upload unless the Access gate is answering in front of the site, and the leaked CSV never touches GitHub. Manual snapshot — the public site refreshes every 6h, the private one only when re-run. Uses `wrangler pages` (static hosting), not a Worker.
- **Feature catalogue**: `make features features-upload` pushes features.fgb to GCS manually (re-run when ch4id's catalogue is rebuilt).

**When adding new web assets**, add them to `scripts/dist.sh` (shared by `deploy.yml` and `update-data.yml`).
