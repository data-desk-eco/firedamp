# Firedamp

Methane plume aggregator — maps satellite-detected methane plumes with nearby O&G infrastructure.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL) with a Python ETL pipeline. No build step, no npm.
Deployed via GitHub Pages; OGIM infrastructure tiles served from GCS (`gs://firedamp-data/`).

## Data sources

- **Carbon Mapper** — satellite plume detections (paginated API → `data/carbon_mapper.csv`)
- **IMEO / MARS** — UNEP methane plume database (auto-fetch attempted, Cloudflare may block → `data/imeo_plumes.csv`)
- **SRON** — TROPOMI weekly plume CSVs (FTP scrape → `data/sron/` → `data/sron_all.csv`)
- **OGIM v2.7** — global O&G infrastructure (Zenodo GeoPackage, 3 GB)

## ETL pipeline

```
make data          # fetch CM + SRON + IMEO, build web/data/plumes.bin
make ogim          # OGIM GeoPackage → web/data/ogim.pmtiles
make ogim-upload   # upload ogim.pmtiles to GCS
make rebuild       # data + ogim + upload
```

Requires `ogr2ogr`, `tippecanoe`, `tile-join` for OGIM build.
IMEO download may be blocked by Cloudflare — if so, download manually from methanedata.unep.org and place CSV at `data/imeo_plumes.csv`.

## Binary format (plumes.bin)

Compact binary: 20 bytes per plume + satellite name table + ID block.
- Header: `FDP1` magic, plume count (u32), satellite table
- Record: lat(f32), lon(f32), days-since-2020(u16), rate_kg/hr(u32), unc(u32), src|sec(u8), sat_idx(u8)
- Footer: newline-separated plume IDs (SRON uses `display_id|source_file` composite format)

## Frontend

Key files:
- `web/app.js` — map setup, binary parser, interactions, detail panel
- `web/style.css` — glass-morphism dark UI, CMY source colors
- `web/layers.js` — custom overlay layers, loaded via `?layer=<slug>` query param

### URL scheme

- Map position: `#map=<zoom>/<lat>/<lon>` (managed by MapLibre)
- Plume permalink: `#plume=<id>` (standalone — position derived from plume data)
- Custom layers: `?layer=<slug>` (e.g. `?layer=permian-fieldwork`)

### Overlap navigation

When multiple plumes share the same location, the detail panel shows prev/next arrows to cycle through them.

## Development

```
make vendor        # download MapLibre, PMTiles, Inter font
make serve         # dev server on :8000 (HTTP Range support for PMTiles)
```

## Deployment

Daily GitHub Action (`update-data.yml`) fetches CM + SRON + IMEO, builds `plumes.bin`, stores it in a GitHub Release (`latest-data`), and deploys to Pages.
Push to `main` also triggers deploy (`deploy.yml`) which pulls `plumes.bin` from the release.
Deploy cache-busts `app.js`, `style.css`, `layers.js` with the git SHA.
OGIM PMTiles uploaded separately via `make ogim-upload`.
`plumes.bin` is NOT committed to git — it lives in the `latest-data` release.

**Important**: when adding new web assets, also add them to the `cp` line in both `deploy.yml` and `update-data.yml`.
