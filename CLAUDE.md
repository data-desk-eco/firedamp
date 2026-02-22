# Firedamp

Methane plume aggregator — maps satellite-detected methane plumes with nearby O&G infrastructure.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL) with a Python ETL pipeline. No build step, no npm.
Deployed via GitHub Pages; OGIM infrastructure tiles served from GCS (`gs://firedamp-data/`).

## Data sources

- **Carbon Mapper** — satellite plume detections (paginated API → `data/carbon_mapper.csv`)
- **IMEO / MARS** — UNEP methane plume database (manual download → `plumes_data/`)
- **SRON** — TROPOMI weekly plume CSVs (FTP scrape → `data/sron/` → `data/sron_all.csv`)
- **OGIM v2.7** — global O&G infrastructure (Zenodo GeoPackage, 3 GB)

## ETL pipeline

```
make data          # fetch CM + SRON, build web/data/plumes.bin
make ogim          # OGIM GeoPackage → web/data/ogim.pmtiles
make ogim-upload   # upload ogim.pmtiles to GCS
make rebuild       # data + ogim + upload
```

Requires `ogr2ogr`, `tippecanoe`, `tile-join` for OGIM build.
IMEO data must be manually placed in `plumes_data/` (download from methanedata.unep.org).

## Binary format (plumes.bin)

Compact binary: 20 bytes per plume + satellite name table + ID block.
- Header: `FDP1` magic, plume count (u32), satellite table
- Record: lat(f32), lon(f32), days-since-2020(u16), rate_kg/hr(u32), unc(u32), src|sec(u8), sat_idx(u8)
- Footer: newline-separated plume IDs

## Development

```
make vendor        # download MapLibre, PMTiles, Inter font
make serve         # dev server on :8000 (HTTP Range support for PMTiles)
```

## Deployment

Push to `main` triggers GitHub Pages deploy (`.github/workflows/deploy.yml`).
OGIM PMTiles uploaded separately via `make ogim-upload`.
