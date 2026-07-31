# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

A [cartograph](~/Tools/cartograph) app — the map system itself is documented
there — with all firedamp behaviour in `web/config.js` plus two hook
modules. The plume aggregation ETL lives in the sibling **etl** repo
(`~/Tools/etl`, 6-hourly publish to the archive); the offline research agent —
the sibling **ch4id** repo — produces the attributions. Served on GitHub
Pages; there is no backend service.

- `web/config.js` — the declarative cartograph config: sources (plume parquet →
  geojson, clustered to z4), four per-source dd flare-marking symbol layers
  (dd map palette: cm cyan, imeo magenta, sron yellow, ghgsat orange, dd green; one
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
  (`web/features.fgb` in the central datadesk archive, ~12M points: OGIM + OSM +
  MapStand + GEM), flatgeobuf
  bbox queries over http range requests: viewport sweep past z13 (padded rect)
  + per-plume radius query on selection (3 km, 10 km for coarse sensors;
  nearest 300; attributed ids always kept, rect stretched to the assessed
  source point). dd waypoint markings, orange + larger when attributed, over an
  invisible fat hit layer carrying the hover/click popup. `normId` maps old
  `OSM:way/<id>` attribution ids to ch4id's short `OSM:w<id>` form.
- `web/licences.js` — MapStand oil and gas licence areas (`web/licences.fgb`,
  98,881 polygons), same flatgeobuf range-read shape: viewport sweep past z6,
  purple boundary over a faint wash, beneath every plume layer, with a key
  toggle. **Private deploy only** — the acreage is licensed data, so the layer
  is gated on `PRIVATE` in `config.js`. Known defect, upstream in etl's
  `catalogue/mirror`: 55.7% of the polygons are rectangles collapsed to
  triangles, because the WMS sweep lets GeoServer generalise geometry to its
  ~2 km render resolution. Position and extent are right, boundaries are not.
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
- **Data Desk (`dd`)** — our own MARS-S2L / hypergas detections, staged from
  the s2e archive view by `make dd` (`data/dd.csv`). Curated: only rows
  the archive marks `valid` (s2e `data/valid-plumes.txt`) pass, deduped
  to one row per target/date/plume with native records preferred over the
  legacy import. Public like every other source. Detail-panel title links to
  the plume preview on the archive
- **ch4id feature catalogue** — OGIM + OSM + MapStand + GEM merged
  (`~/Tools/ch4id/data/features.parquet`, ~15M features; ~12M exported as points)

## Central data archive

Firedamp serves its data from the shared datadesk CloudFerro bucket
(`https://s3.WAW3-2.cloudferro.com/datadesk-archive`, the `data-bucket` meta;
defined in `~/Tools/data-desk/infra/archive.sh`; layout in `data-desk/docs/archive/`).
The `views/plumes/` aggregation and `web/features.fgb` catalogue are
both produced by the `etl` repo; firedamp only reads them.

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

Dev (`localhost`) reads plumes locally if `web/data/plumes.parquet` exists
(copy one from the etl repo), else the archive; feature catalogue from the archive. Verify with the `browse` cli: `window.cartograph` exposes `{ map, sources, … }`.

## Deployment

- **Pages**: push to `main` runs `deploy.yml` — `scripts/dist.sh` (copies
  `web/*`, cache-busts entry points / app-local imports / parquet fetches with
  the git SHA — vendor modules stay unbusted so each resolves to one URL = one
  module instance) and deploys. No plume data in the artifact: the site reads
  `views/plumes/data.parquet` live from the archive (hourly cache-buster in the URL).
- **Plumes refresh**: `etl/plumes.yml` every 6h in the etl repo — no redeploy
  needed, the site reads the archive live.
- **Private deploy**: `make deploy-private` — builds `plumes.parquet` via the
  etl repo (including any source held back from the public archive) and bakes
  it into the dist (`dist.sh <sha> local` sets `<meta name="local-plumes">`),
  shipped to Cloudflare Pages project `firedamp-private` behind Cloudflare
  Access; refuses to deploy unless the Access gate is answering. The **only**
  deploy that carries restricted sources — etl's `plumes-upload` refuses to
  publish a parquet containing them. `config.js` lists them in `PRIVATE_SRCS`.
  Data Desk rows are public (curated valid-only).
- **Feature catalogue**: published by the etl repo
  (re-run when the catalogue is rebuilt).

**When adding new web assets**, add them to `scripts/dist.sh` (shared by both
deploy workflows).
