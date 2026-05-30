# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL, no build step, no npm) on GitHub Pages, a Python ETL pipeline that produces `plumes.bin`, and a Cloudflare Worker (`firedamp-api`) that proxies AI analysis requests to OpenRouter and caches them in D1.

- OGIM infrastructure PMTiles served from GCS (`gs://firedamp-data/`).
- `plumes.bin` lives in the `latest-data` GitHub Release, not in git.
- AI analyses live in Cloudflare D1 (`firedamp-analyses`), with a daily snapshot to the same Release.

## Plume sources

- **Carbon Mapper** — satellite + aircraft hyperspectral (API → `data/carbon_mapper.csv`)
- **IMEO / MARS** — UNEP methane plume database (web scrape → `data/imeo_plumes.csv`)
- **SRON** — TROPOMI weekly plume CSVs (FTP scrape → `data/sron/` → `data/sron_all.csv`)
- **OGIM v2.7** — global O&G infrastructure (Zenodo GeoPackage, ~3 GB)

## ETL

```
make data          # CM + SRON + IMEO → web/data/plumes.bin
make ogim          # OGIM GeoPackage → web/data/ogim.pmtiles
make ogim-upload   # PMTiles → GCS
make rebuild       # data + ogim + upload
```

Requires `ogr2ogr`, `tippecanoe`, `tile-join` for OGIM. IMEO scrape can be blocked by Cloudflare — if so, drop the CSV manually at `data/imeo_plumes.csv`.

## Binary format (plumes.bin)

20 bytes per plume + satellite name table + ID block.
- Header: `FDP1` magic, plume count (u32), satellite table.
- Record: lat(f32), lon(f32), days-since-2020(u16), rate_kg/hr(u32), unc(u32), src|sec(u8), sat_idx(u8).
- Footer: newline-separated plume IDs (SRON uses `display_id|source_file` composite).

## AI plume analysis

Detail panel gathers these in parallel (search radius scales with the source's spatial uncertainty — see below):
- OGIM facilities / wells / pipeline segments (local tile query).
- OSM features via Overpass.
- Reverse-geocoded place name (Nominatim).
- Daily-mean surface wind for the plume coord+date (Open-Meteo archive).

The design philosophy is **one clean artifact + the model's own judgement**, not a rulebook. The pipeline produces a single annotated satellite map (`captureAnnotatedMap` in `web/app.js`) — Esri imagery framed to the uncertainty, with a dashed uncertainty ring, a wind arrow, the magenta ⊕ detection marker, and **numbered pins** for the nearest ~12 merged OGIM+OSM features. The prompt (`buildPlumePrompt`) describes the map briefly, lists the pins as a text **KEY** (number → name/type/`OGIM:`/`OSM:` id), and asks the model to read the imagery and attribute the source. Sent to the Worker → OpenRouter with `source_label`, `source_kind`, `attributed_id`, `paragraph` output, stored in D1.

**Peek shortcut**: re-opening an already-analysed plume hits `GET /api/analysis/<plumeId>`, restores from D1, and skips Overpass / Nominatim / Open-Meteo / image / OpenRouter. The regenerate `↻` button forces a full re-run (`force: true`).

**Key handling**: OpenRouter key is a Wrangler secret on the Worker — never in the browser. Worker URL is configured via `<meta name="firedamp-api">` in `web/index.html`. Local Worker dev: `make worker-dev` then visit `?api=local`.

**Spatial uncertainty** (`plumeUncertainty` in `web/app.js`) drives the map frame size, the search radius, and the dashed ring, per source/sensor:
- CM AVIRIS-NG/GAO/AV3/AV20: tens of m → tight ~0.5 km frame.
- CM Tanager/EnMAP: ~50 m. CM satellite (EMIT etc.): ~100 m → ~1 km frame.
- IMEO: <500 m to a few km → ~3 km frame.
- SRON/TROPOMI: pixel ~5.5×7 km; source ≈2 km (isolated) to 10 km+ (cluttered), almost always **upwind**. Frame is ~11 km, **shifted upwind** by the daily-mean wind so the search area fills it; ~11 km search radius. The ⊕ is the centre of a search area, not the source.

## Worker (`worker/`)

Cloudflare Worker `firedamp-api`. See `worker/README` for setup and endpoints. Common ops:

```
make worker-dev      # wrangler dev on :8787
make worker-deploy   # wrangler deploy
make worker-schema   # apply schema.sql to remote D1
make worker-tail     # tail Worker logs
```

**Model config** (`wrangler.toml` vars): `MODEL` is the OpenRouter model (currently `qwen/qwen3-vl-235b-a22b-instruct` — a cheap, strong vision model; the task always sends an image so the model must be multimodal). `MODEL_FALLBACK` (`qwen/qwen3-vl-32b-instruct`) is used after the primary hits a transient 429/502/503. Results are always cached/stored under `MODEL` regardless of which answered, so peek stays coherent. Note: OpenRouter `:free` routes (e.g. Google AI Studio) are too rate-limited for image requests — avoid them as the primary. `response_format` JSON schema is sent without `require_parameters` (providers that ignore it still work because the prompt asks for the JSON and the client parses defensively).

## Frontend

Key files:
- `web/app.js` — map setup, binary parser, interactions, detail panel, AI client.
- `web/style.css` — glass-morphism dark UI, CMY source colours.
- `web/layers.js` — custom overlay layers, loaded via `?layer=<slug>`.
- `web/dataset.html` — AI dataset browser (in source, but not linked from the main UI and not copied into the Pages deploy yet; re-enable by uncommenting the subtitle link in `index.html` and restoring the `cp` lines in the two deploy workflows).

### URL scheme

- `#map=<zoom>/<lat>/<lon>` — MapLibre-managed.
- `#plume=<id>` — plume permalink (position derived from data).
- `?layer=<slug>` — custom overlay (see `layers.js`).
- `?api=local` — point AI requests at `http://localhost:8787` (wrangler dev).

### Overlap navigation

When multiple plumes share a location, the detail panel shows prev/next arrows to cycle.

## Development

```
make vendor        # MapLibre, PMTiles, Inter font
make serve         # dev server on :8000 (HTTP Range for PMTiles)
```

## Deployment

- **Pages**: push to `main` runs `deploy.yml`. Pulls `plumes.bin` from the `latest-data` Release, copies `web/*` into `dist/`, cache-busts JS/CSS with the git SHA, and deploys.
- **Plumes refresh**: `update-data.yml` runs daily (06:00 UTC), rebuilds `plumes.bin`, uploads to the Release, and redeploys Pages.
- **AI dataset snapshot**: `export-analyses.yml` runs daily (06:30 UTC), dumps `/api/analyses` to `analyses.json{,.gz}` in the same Release as a durability backup.
- **OGIM tiles**: `make ogim-upload` pushes to GCS manually (rarely re-run).
- **Worker**: `make worker-deploy` (separate from Pages).

**When adding new web assets**, add them to the `cp` line in both `deploy.yml` and `update-data.yml`.
