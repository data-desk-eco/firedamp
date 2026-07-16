# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

A [cartograph](~/Tools/cartograph) app — the map system itself is documented
there — with all firedamp behaviour in `web/config.js` plus two hook
modules. A Python ETL produces `web/data/plumes.parquet`; the offline research
agent — the sibling **ch4id** repo (`~/Tools/ch4id`) — produces
`web/data/attributions.parquet` (committed, the attribution source of truth).
Served on GitHub Pages; there is no backend service.

- `web/config.js` — the declarative cartograph config: sources (plume parquet →
  geojson, clustered to z4), four per-source dd flare-marking symbol layers
  (dd map palette: cm cyan, imeo magenta, sron yellow, ghgsat orange; one
  fixed size, t/hr labels) plus a non-interactive white cluster layer
  labelled with summed t/hr,
  attribution/date filters, key (toggleable rate ranges + source toggles),
  data table tabs (detections, attributions), detail panel.
- `web/attribution.js` — attribution lookup (full attributions.parquet into a
  Map at boot, keyed by plume display id) + rendering (source label linking to
  osm.org or flying to the feature, "(confidence: …)" after the label,
  paragraph, evidence links), and the per-plume daily-mean surface wind stat
  (Open-Meteo archive).
- `web/candidates.js` — candidate sources from the ch4id feature catalogue
  (`features/data.fgb` in the central datadesk store, ~12M points: OGIM + OSM +
  MapStand + GEM), flatgeobuf
  bbox queries over http range requests: viewport sweep past z13 (padded rect)
  + per-plume radius query on selection (3 km, 10 km for coarse sensors;
  nearest 300; attributed ids always kept, rect stretched to the assessed
  source point). dd waypoint markings, orange + larger when attributed, over an
  invisible fat hit layer carrying the hover/click popup. `normId` maps old
  `OSM:way/<id>` attribution ids to ch4id's short `OSM:w<id>` form.
- `web/vendor/` — committed: maplibre, hyparquet, inter, flatgeobuf, `dd/`
  (design dist) and `cartograph/` (the generic core). Refresh with `make
  vendor` (calls cartograph's vendor.sh, which pulls dd from ~/Tools/design).

Everything generic — dd map shell, panels, key, filters, detail/overlap-nav/
permalinks, search, parquet data layer — lives in vendored cartograph; keep
firedamp specifics out of it (change cartograph and re-vendor instead).

## Plume sources

- **Carbon Mapper** — satellite + aircraft hyperspectral (API → `data/carbon_mapper.csv`)
- **IMEO / MARS** — UNEP methane plume database (public Azure zip → `data/imeo_plumes.csv`)
- **SRON** — TROPOMI weekly plume CSVs (FTP scrape → `data/sron/` → `data/sron_all.csv`)
- **GHGSat** — leaked, local-only `data/ghgsat.csv`; only ever enters the
  private deploy (see Deployment)
- **ch4id feature catalogue** — OGIM + OSM + MapStand + GEM merged
  (`~/Tools/ch4id/data/features.parquet`, ~15M features; ~12M exported as points)

## Central data store

Firedamp serves its data from the shared datadesk CloudFerro bucket
(`https://s3.WAW3-2.cloudferro.com/datadesk-archive`, the `data-bucket` meta;
defined in `~/Tools/s2-flares/cloud/store.sh`). Firedamp owns the `plumes/`
prefix (`plumes/data.parquet` + the CI source-csv cache `plumes/sources.zip`);
the feature catalogue at `features/data.fgb` is owned and published by ch4id
(`make -C ~/Tools/ch4id features`).

## ETL

```
make data             # CM + SRON + IMEO → web/data/plumes.parquet
make plumes-upload    # publish plumes.parquet to the store (CI does this 6-hourly)
```

`scripts/build.py` normalises the source CSVs into one zstd parquet: `id, link,
src, lat, lon, dt, rate (kg/hr), unc, sat, sec`. SRON ids are the
date+location display id with the source csv filename in `link` (the old FDP1
`display|file` composite, split out); attribution keys match `id` directly.
The old FDP1/FDA2 binaries and `build_attr.py` are gone — the frontend reads
both parquets straight in with hyparquet (pure js, no wasm).

IMEO comes from UNEP's public detected-plumes dataset — a keyless Azure blob
zip (linked from methanedata.unep.org/download-dataset, refreshed ~monthly).
`fetch_imeo.py` pulls it with plain `httpx` and on any network failure keeps
the existing `data/imeo_plumes.csv`.

## Frontend data flow

`config.js` prefetches `plumes.parquet` at parse, reads both parquets with
hyparquet, and builds one geojson source: every plume whose id appears in
`attributions.parquet` gets `attr: 1`, which feeds the Attribution filter.
The detail panel is cartograph-generic (title link to CM/SRON, coords,
overlap nav across co-located plumes, `#plume=<id>` permalinks alongside
`#map=`); firedamp's `config.js` detail template adds source/sector badges and a stats grid
(rate, wind, satellite, date), and `onShow` fills in wind, the attribution
record and the candidate-source selection.

## Development

```
make vendor        # vendor deps (cartograph, dd, maplibre, hyparquet, flatgeobuf, inter)
make serve         # dev server on :8000 (HTTP Range for FlatGeobuf)
```

Dev (`localhost`) reads plumes locally (`web/data/plumes.parquet`, `make data`)
and the feature catalogue from the store. Verify with the `browse` cli: `window.cartograph` exposes `{ map, sources, … }`.

## Deployment

- **Pages**: push to `main` runs `deploy.yml` — `scripts/dist.sh` (copies
  `web/*`, cache-busts entry points / app-local imports / parquet fetches with
  the git SHA — vendor modules stay unbusted so each resolves to one URL = one
  module instance) and deploys. No plume data in the artifact: the site reads
  `plumes/data.parquet` live from the store (hourly cache-buster in the URL).
- **Plumes refresh**: `update-data.yml` every 6h — rebuilds `plumes.parquet`
  against the store's source-csv cache, and when bytes changed uploads
  `plumes/data.parquet` + `plumes/sources.zip` to the store (secrets
  `CLOUDFERRO_S3_KEY`/`CLOUDFERRO_S3_SECRET`). No redeploy needed.
- **Private deploy**: `make deploy-private` — builds `plumes.parquet` locally
  (including gitignored `data/ghgsat.csv`) and bakes it into the dist
  (`dist.sh <sha> local` sets `<meta name="local-plumes">`), shipped to
  Cloudflare Pages project `firedamp-private` behind Cloudflare Access; refuses
  to deploy unless the Access gate is answering. The **only** deploy that ever
  contains GHGSat — `upload_plumes.sh` refuses to publish a ghgsat-carrying
  parquet to the store.
- **Feature catalogue**: owned by ch4id — `make -C ~/Tools/ch4id features`
  (re-run when the catalogue is rebuilt).

**When adding new web assets**, add them to `scripts/dist.sh` (shared by both
deploy workflows).
