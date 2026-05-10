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

Detail panel runs through these in parallel:
- OGIM facilities / wells / pipeline segments within ~2 km (local tile query).
- OSM features within ~2 km via Overpass.
- Reverse-geocoded place name (Nominatim).
- Daily-mean surface wind for the plume coord+date (Open-Meteo archive).
- Esri imagery snapshot, with the plume location and OGIM features painted onto it.

These get assembled into a prompt and sent to the Worker, which forwards to OpenRouter with strict JSON schema output (`source_label`, `source_kind`, `attributed_id`, `paragraph`) and stores the result in D1.

**Peek shortcut**: re-opening an already-analysed plume hits `GET /api/analysis/<plumeId>`, restores from D1, and skips Overpass / Nominatim / Open-Meteo / image / OpenRouter. The regenerate `↻` button forces a full re-run (`force: true`).

**Key handling**: OpenRouter key is a Wrangler secret on the Worker — never in the browser. Worker URL is configured via `<meta name="firedamp-api">` in `web/index.html`. Local Worker dev: `make worker-dev` then visit `?api=local`.

**Spatial uncertainty in prompt**: source-and-satellite-specific. AVIRIS-NG/GAO: metres-precision. CM satellite hyperspectral: ~30-100 m. IMEO: <500 m to several km. SRON/TROPOMI: ~5.5×7 km pixel; the marker is often km from the leak; check upwind.

## Worker (`worker/`)

Cloudflare Worker `firedamp-api`. See `worker/README` for setup and endpoints. Common ops:

```
make worker-dev      # wrangler dev on :8787
make worker-deploy   # wrangler deploy
make worker-schema   # apply schema.sql to remote D1
make worker-tail     # tail Worker logs
```

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
