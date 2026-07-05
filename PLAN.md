# plan: static infra queries (kill overpass + OGIM tiles)

replace per-plume overpass calls and the OGIM PMTiles layer with two
flatgeobuf files on GCS, bbox-queried over HTTP range requests, and show the
queried candidates on the map.

rationale (benchmarked 2026-07-05, 334k-well sample): FGB bbox query = 8
requests / 633 KB / 64 ms with a ~90 KB JS client; full OSM sweep for our
overpass tags is ~9–10M features globally (QLever export: 334k features in
3.4 s/query, snapshot ≤2 wk old). duckdb-wasm+geoparquet lost only on the
34 MB wasm. FGB is uncompressed (~2–3 GB total on GCS) — storage is pennies,
reads stay small.

## 1. etl

- `scripts/fetch_osm.py` — ~35 SPARQL queries (one per tag class from
  `buildOverpassQuery`) against `https://qlever.dev/api/osm-planet`, TSV to
  `data/osm/`. columns: id, `geof:centroid`, `geof:envelope`, name, name:en,
  operator, product, resource + the type tags the KEY uses (man_made,
  industrial, power, plant:source, substance, building, landuse, amenity,
  aeroway, pipeline, generator:source).
- `scripts/build_infra.sh` — duckdb (spatial):
  - `infra.fgb` (points): OSM centroids ∪ OGIM wells/facilities from the
    gpkg (`st_read`; keep OGIM_ID/FAC_NAME/FAC_TYPE/CATEGORY/OPERATOR/
    OGIM_STATUS/COUNTRY, apply existing well/status filters), `src` column
    (osm|ogim), envelope corners as plain cols for boundsDist.
  - `pipelines.fgb` (lines): OGIM pipelines only (drawn on the capture map).
  - hilbert order is implicit in the FGB index; drop tippecanoe/tile-join.
- makefile: `infra` + `infra-upload` (→ `gs://firedamp-data/`); retire
  `ogim`/`ogim-upload`; delete `build_ogim.sh`. check bucket CORS exposes
  range on *.fgb.

## 2. frontend query path

- vendor flatgeobuf geojson client in `scripts/vendor.sh`.
- new `web/infra.js` replaces `ogim.js`: `queryInfra(lon, lat, radiusKm)` →
  two parallel fgb bbox streams → candidate objects shaped like today's
  merged OGIM+OSM list (id, kind, name, tags, lat/lon, bounds, dist,
  pipeline geometry). broad/named-buildings tiering (barns, farmyards,
  unnamed industrial) becomes a client-side filter on the tag columns.
- delete from `analysis.js`: `OVERPASS_ENDPOINTS`, `buildOverpassQuery`,
  `queryOverpass`, `summariseOsmElements` (dedup by osm id instead of tag
  json). nearby-infrastructure accordion = same query, `src=ogim`, 2 km.
- delete from `ogim.js`: toggle + legend + icons + preload layers + the
  idle-race `loadNearbyInfra` (7 s stall on empty areas) + tile-dependent
  `flyToOgim` (fly to stored candidate coords instead).

## 3. candidate display

- `candidates` geojson source, populated when the model is queried with the
  same numbered list that feeds the capture map + KEY: circle+number symbol
  pins in `PIN_FILL` colours, pipeline candidates as yellow lines.
- on answer: highlight the attributed candidate (feature-state), dim the
  rest; label click = existing fly-to. cleared by `cancelAnalysis`/close.
- remove the OGIM toggle row from index.html; `ogim-bucket` meta → keep
  bucket meta for fgb urls.

## 4. verify

- `?debug` on fixture plumes (matuail, reagan county, jankowice, a SRON
  wide frame): KEY parity with the overpass version, capture map pins drawn,
  timing.
- dev: assert the server honours range (duckdb/fgb silently full-download
  otherwise); `scripts/serve.py` already does.
- update CLAUDE.md architecture/ETL sections; dist.sh untouched (fgb lives
  on GCS, not in the pages artifact).
