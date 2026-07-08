# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL, no build step, no npm) on GitHub Pages, a Python ETL pipeline that produces `plumes.bin`, and an offline research agent that produces `attributions.json`. Attribution is served entirely from that static dataset — there is no backend service any more (the old `firedamp-api` Cloudflare Worker + D1 vision pipeline was removed).

- OGIM infrastructure PMTiles served from GCS (`gs://firedamp-data/`).
- `plumes.bin` lives in the `latest-data` GitHub Release, not in git.

## Plume sources

- **Carbon Mapper** — satellite + aircraft hyperspectral (API → `data/carbon_mapper.csv`)
- **IMEO / MARS** — UNEP methane plume database (Eye on Methane v2 API → `data/imeo_plumes.csv`)
- **SRON** — TROPOMI weekly plume CSVs (FTP scrape → `data/sron/` → `data/sron_all.csv`)
- **OGIM v2.7** — global O&G infrastructure (Zenodo GeoPackage, ~3 GB)

## ETL

```
make data          # CM + SRON + IMEO → web/data/plumes.bin
make ogim          # OGIM GeoPackage → web/data/ogim.pmtiles
make ogim-upload   # PMTiles → GCS
make rebuild       # data + ogim + upload
```

Requires `ogr2ogr`, `tippecanoe`, `tile-join` for OGIM. IMEO needs `IMEO_API_KEY` (request from unep-methanedata@un.org; set as a repo secret for CI). The whole `methanedata.unep.org` host is behind a Cloudflare managed challenge that fingerprints the TLS handshake, so `fetch_imeo.py` uses `curl_cffi` (Chrome JA3 impersonation) — plain httpx/requests/curl are blocked even with the key. Without a key it keeps any existing `data/imeo_plumes.csv` (manual fallback).

## Binary format (plumes.bin)

20 bytes per plume + satellite name table + ID block.
- Header: `FDP1` magic, plume count (u32), satellite table.
- Record: lat(f32), lon(f32), days-since-2020(u16), rate_kg/hr(u32), unc(u32), src|sec(u8), sat_idx(u8).
- Footer: newline-separated plume IDs (SRON uses `display_id|source_file` composite).

## Plume attribution (frontend)

The detail panel serves source attribution **solely** from the bulk agentic dataset (`web/data/attributions.json`, produced by `agent/` below). `web/analysis.js` looks the plume up by id and renders `source_label` (a fly-to link when `attributed_id` is an `OGIM:`/`OSM:` ref), `confidence`, `paragraph` and `evidence` links; a plume with no record shows "No source attribution yet." Daily-mean surface wind (Open-Meteo archive) is still fetched per plume as an independent panel stat, unrelated to attribution.

There is **no in-browser vision/LLM pipeline** any more. The old on-demand path — Overpass + Nominatim + Open-Meteo + an annotated Esri map (`captureAnnotatedMap`) sent to the Worker → OpenRouter, with a `↻` regenerate button and a D1 peek cache — was removed (git history has it). `attributions.json`, committed to git and reviewed in PRs, is the single source of truth. It stays a JSON blob rather than folding into `plumes.bin`: the records are sparse, variable-length, multilingual prose with URL arrays, a poor fit for the fixed-width `FDP1` record that CI rebuilds from CSV every 6 h.

`attributions.json` also drives map styling: `app.js` loads it (via `loadAttributions()` in `analysis.js`), and `addPlumeLayers` gives every plume whose id is in the set a semi-transparent fill in its source colour (`circle-opacity` case on an `attr` property) so attributed plumes read as filled discs against the hollow rings of the rest.

## Agentic attribution (`agent/`)

The sole attribution mechanism: `agent/run.py` loops through plumes and runs a full research agent per plume — pi headless driving DeepSeek (`deepseek-v4-pro`, needs `DEEPSEEK_API_KEY`) with bash + web tools — no image input (DeepSeek is text-only), but the CM plume rasters land in the run dir ready for a future multimodal model, and the agent can analyse them geospatially via python. Results accumulate in `web/data/attributions.json` (committed to git; dist.sh copies it), which the frontend serves directly.

Per plume the driver assembles `context.json` from local data via `data/context.duckdb` (`make attr-db`, ~1 GB, rebuild after refreshing sources): OGIM v2.7 point layers + the containing O&G field, Global Coal Mine Tracker mines, the full 4-source detection history within 10–30 km (repeat detections are the strongest single signal). Live APIs supply the rest (all fetched per run, so a future pipeline can attribute new plumes with no local rebuild): a live Overpass export of the area (raw response saved as `osm.json` in the run dir; falls back to the local `data/osm/*.csv` extract when Overpass is down — note Overpass 406s on python's default User-Agent), MapStand O&G features (wellheads/platforms/terminals/pipelines/licence areas/accumulations/basins via WMS `GetFeatureInfo` with a full-canvas pixel buffer — MapStand has no WFS; `MAPSTAND_API_KEY` in `.env`), Carbon Mapper's per-plume rasters for `cm` plumes (georeferenced `plume_tif`/`con_tif` + rgb/plume PNGs downloaded into the run dir for the agent to analyse — signed URLs from `/api/v1/catalog/plumes/annotated`, which also enriches `source_record` with gsd/off-nadir/sector), Open-Meteo wind and a Nominatim place (cached in `data/cache/`). Search radius scales with sensor uncertainty like the frontend `SENSORS` table, but wider (1.5–15 km). GHGSat also serves per-plume rasters (`assets` in `data/ghgsat.csv`) but they need spectra-api auth we don't have.

For Permian Basin plumes a `permian` context block adds Texas RRC / New Mexico OCD regulatory data and independent flare observations from the sibling **gaslight** project's shareable DuckDB (`make gaslight` downloads it from the `db-latest` release of `data-desk-eco/gaslight`; refresh after gaslight's `make release`): wells with per-lease operator-reported flaring volumes, SWR-32 flare permits, R-3 gas plants, NM flare/vent incident reports, and VIIRS Nightfire + Sentinel-2 observed flare sites — a plume at a flare site with no coincident IR signal reads as an unlit/venting flare. The DB is attached read-only as `gl` when `data/gaslight.duckdb` exists; without it the block is simply absent.

The agent brief is `agent/task.md`: hypothesise from local evidence → research candidates on the web (`agent/bin/websearch` = DDG lite; `agent/bin/webget` = Jina reader with raw fallback; local-language searches encouraged) → cross-check against detection history → decide honestly, writing `result.json` (`source_label`, `source_kind`, `attributed_id`, `paragraph`, plus `source_name`, `operator`, `confidence`, `evidence` URLs). The driver validates `attributed_id` against the context (invented ids are nulled) before merging.

```
make attr-db                     # build data/context.duckdb
uv run agent/run.py <ids...>     # attribute specific plumes
uv run agent/run.py --top 50 --src sron -j 4
```

Already-attributed plumes are skipped unless `-f`. Full transcripts land in `agent/runs/<id>/log.json` (gitignored) — review them when iterating on the brief. ~5 min and ~1¢ per plume.

## Frontend

ES modules, no build step. Key files:
- `web/app.js` — entry point: data load, layer assembly, UI wiring.
- `web/map.js` — map instance + basemap style.
- `web/plumes.js` — binary parser, plume layers, filters.
- `web/ogim.js` — OGIM layers, toggle, proximity queries.
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
make vendor        # MapLibre, PMTiles, Inter font
make serve         # dev server on :8000 (HTTP Range for PMTiles)
```

## Deployment

- **Pages**: push to `main` runs `deploy.yml`. Pulls `plumes.bin` from the `latest-data` Release, copies `web/*` into `dist/`, cache-busts JS/CSS with the git SHA, and deploys.
- **Plumes refresh**: `update-data.yml` runs every 6h (00:00/06:00/12:00/18:00 UTC), rebuilds `plumes.bin`, uploads to the Release, and redeploys Pages. Carbon Mapper publishes in sub-daily batches so it's polled often; SRON (weekly) and IMEO (irregular) don't gain much from the higher cadence but ride along.
- **Private deploy**: `make deploy-private` — builds `plumes.bin` locally (pulling in the local-only, gitignored `data/ghgsat.csv`) and pushes the site to Cloudflare Pages project `firedamp-private` (`https://firedamp-private.pages.dev`), which sits behind Cloudflare Access (Zero Trust app "Firedamp private", "Data Desk" policy = the three datadesk.eco emails, covering prod + `*.pages.dev` previews). This is the **only** deploy that ever contains GHGSat: the target refuses to upload unless the Access gate is answering in front of the site, and the leaked CSV never touches GitHub. Manual snapshot — the public site refreshes every 6h, the private one only when re-run. Uses `wrangler pages` (static hosting), not a Worker.
- **OGIM tiles**: `make ogim-upload` pushes to GCS manually (rarely re-run).

**When adding new web assets**, add them to `scripts/dist.sh` (shared by `deploy.yml` and `update-data.yml`).
