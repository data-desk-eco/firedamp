# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL, no build step, no npm) on GitHub Pages, a Python ETL pipeline that produces `plumes.bin`, and a Cloudflare Worker (`firedamp-api`) that proxies AI analysis requests to OpenRouter and caches them in D1.

- OGIM infrastructure PMTiles served from GCS (`gs://firedamp-data/`).
- `plumes.bin` lives in the `latest-data` GitHub Release, not in git.
- AI analyses live in Cloudflare D1 (`firedamp-analyses`), with a daily snapshot to the same Release.

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

## AI plume analysis

Detail panel gathers these in parallel (search radius scales with the source's spatial uncertainty — see below):
- OGIM facilities / wells / pipeline segments (local tile query).
- OSM features via Overpass, with tiered breadth: tight frames (searchKm ≤ 1.5, i.e. precise sensors) also sweep generic industrial/agricultural buildings and farmyards — real sources are often mapped only as `building=industrial` + a name (e.g. mine ventilation shafts); wide TROPOMI frames keep named buildings only so barns don't drown the KEY.
- Reverse-geocoded place name (Nominatim).
- Daily-mean surface wind for the plume coord+date (Open-Meteo archive).

The design philosophy is **one clean artifact + the model's own judgement**, not a rulebook. The prompt is deliberately minimal — primarily data (detection record, map, wind, KEY) plus a few neutral sentences of instruction; no source-type ranking heuristics (a "landfill outranks everything" hint once sent a mislabelled Silesian spoil heap to production). The pipeline produces a single annotated satellite map (`captureAnnotatedMap` in `web/analysis.js`) — Esri imagery framed to the uncertainty, with a dashed uncertainty ring, a wind arrow, the magenta ⊕ detection marker, and **numbered pins** for the nearest ~12 merged OGIM+OSM features. The prompt (`buildPlumePrompt`) describes the map briefly, lists the pins as a text **KEY** (number → name/type/`OGIM:`/`OSM:` id), and asks the model to read the imagery and attribute the source. Sent to the Worker → OpenRouter with `source_label`, `source_kind`, `attributed_id`, `paragraph` output, stored in D1.

**Peek shortcut**: re-opening an already-analysed plume hits `GET /api/analysis/<plumeId>`, restores from D1, and skips Overpass / Nominatim / Open-Meteo / image / OpenRouter. The regenerate `↻` button forces a full re-run (`force: true`).

**Key handling**: OpenRouter key is a Wrangler secret on the Worker — never in the browser. Worker URL is configured via `<meta name="firedamp-api">` in `web/index.html`. Local Worker dev: `make worker-dev` then visit `?api=local`.

**Spatial uncertainty** (`SENSORS` table in `web/analysis.js`) drives the map frame size, the search radius, and the dashed ring, per source/sensor. Each row holds `specM` (published positional accuracy) and optionally `empM` — a tracked empirical override adopted where observed repeat-detection scatter contradicts the spec, with the evidence kept in the row's comment. Current rows:
- CM AVIRIS-NG/GAO/AV3/AV20: ~30 m → tight ~0.16 km frame.
- CM Tanager/EnMAP: ~45 m. CM satellite (EMIT etc.): ~100 m → ~0.6 km frame.
- IMEO: ~600 m (analyst-vetted, mixed sensors) → ~3 km frame.
- GHGSat: spec ~50 m, **widened empirically to 150 m** (repeat detections over the Jankowice mine vent shaft scatter ~130 m; the old 160 m frame cropped the true source out of the KEY) → ~0.9 km frame.
- SRON/TROPOMI: pixel ~5.5×7 km; source ≈2 km (isolated) to 10 km+ (cluttered), almost always **upwind**. Frame is ~11 km, **shifted upwind** by the daily-mean wind so the search area fills it; ~11 km search radius. The ⊕ is the centre of a search area, not the source.

## Worker (`worker/`)

Cloudflare Worker `firedamp-api`. See `worker/README` for setup and endpoints. Common ops:

```
make worker-dev      # wrangler dev on :8787
make worker-deploy   # wrangler deploy
make worker-schema   # apply schema.sql to remote D1
make worker-tail     # tail Worker logs
```

**Model config** (`wrangler.toml` vars): `MODEL` is the OpenRouter model (currently `qwen/qwen3-vl-235b-a22b-instruct` — a cheap, strong vision model; the task always sends an image so the model must be multimodal). `MODEL_FALLBACK` (`qwen/qwen3-vl-32b-instruct`) is used after the primary hits a transient 429/502/503. Results are always cached/stored under `MODEL` regardless of which answered, so peek stays coherent. Note: OpenRouter `:free` routes (e.g. Google AI Studio) are too rate-limited for image requests — avoid them as the primary.

Tested 2026-06-11: `google/gemini-3.5-flash` (note: Gemini **2.5** Flash was briefly the production model in May — commit 71f6a4d — before Gemma 4 and Qwen; 3.5 had not been tested before). Reasoning is **mandatory** on this endpoint (`reasoning: {enabled: false}` → hard error) and at the default effort it eats the whole `max_tokens: 700` budget (`finish_reason: length`, truncated JSON) on 6/8 fixtures — it only works with `reasoning: {effort: "low"}` **and** `max_tokens` raised to ~1500. With that config, on 8 live-format fixtures (current annotated-map prompt, captured via `promptlab/live/capture.py`): attribution matches or beats Qwen on all clear ground-truth cases (Matuail, Reagan County/Energy Transfer, Cimarex, Fos Tonkin, Coppabella), id discipline is perfect (21/21 `attributed_id` verbatim from the KEY, including non-Latin-name OSM features where nemotron failed 4/4), run-to-run consistency is high (3/3 identical on 6/8), and paragraphs follow the rubric. Its imagery reading is genuinely strong — e.g. it named the Aux Sable gas plant from the image with a correct `null` id when the plant wasn't in the KEY. Weaknesses: looser restraint than Qwen on the no-source TROPOMI control (3/3 attributed a small waste-transfer node to a 54 t/hr plume where "no obvious source" is the accepted answer), and ~15–20× the cost (~0.7–1.0¢/analysis vs ~0.04–0.06¢ — reasoning tokens bill at $9/M output). Latency comparable (2–8 s). Not adopted: quality is at least Qwen-par but the cost multiple plus the Worker changes (reasoning param, token budget) aren't justified by two ambiguous-case wins. Worth revisiting if attribution quality becomes the binding constraint.

Tested 2026-06-11: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` (multimodal, ~1.6 s/response, no burst 429s over 14 calls). With the Worker's current body it returns **empty output every time** — reasoning consumes the whole `max_tokens: 700` budget (`finish_reason: length`, zero content); it only answers with `reasoning: {enabled: false}` added to the request (a lesson that applies to any reasoning model considered here). With reasoning off, attribution on two ground-truth plumes (Matuail landfill, Reagan County gas facility) matched Qwen, but id discipline is worse: it put the candidate *name* or the whole KEY line into `attributed_id` in 4/4 runs where the feature name was non-Latin (Bengali), vs 4/4 verbatim-correct on Latin OGIM ids, and paragraphs sometimes mention the ⊕ despite the prompt. Malformed ids degrade gracefully (label renders, no fly-to link) but pollute the dataset. It also ignores `response_format` (JSON arrived via the prompt alone). Not adopted. `response_format` JSON schema is sent without `require_parameters` (providers that ignore it still work because the prompt asks for the JSON and the client parses defensively).

## Frontend

ES modules, no build step. Key files:
- `web/app.js` — entry point: data load, layer assembly, UI wiring.
- `web/map.js` — map instance + basemap style.
- `web/plumes.js` — binary parser, plume layers, filters.
- `web/ogim.js` — OGIM layers, toggle, proximity queries.
- `web/detail.js` — detail panel, permalinks, overlap nav, interactions.
- `web/analysis.js` — AI attribution pipeline + Worker client.
- `web/util.js` — geometry + formatting helpers.
- `web/style.css` — glass-morphism dark UI, CMY source colours.
- `web/dataset.html` — AI dataset browser (in source, but not linked from the main UI and not copied into the Pages deploy yet; re-enable by uncommenting the subtitle link in `index.html` and adding it to `scripts/dist.sh`).

### URL scheme

- `#map=<zoom>/<lat>/<lon>` — MapLibre-managed.
- `#plume=<id>` — plume permalink (position derived from data).
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
- **Plumes refresh**: `update-data.yml` runs every 6h (00:00/06:00/12:00/18:00 UTC), rebuilds `plumes.bin`, uploads to the Release, and redeploys Pages. Carbon Mapper publishes in sub-daily batches so it's polled often; SRON (weekly) and IMEO (irregular) don't gain much from the higher cadence but ride along.
- **AI dataset snapshot**: `export-analyses.yml` runs daily (06:30 UTC), dumps `/api/analyses` to `analyses.json{,.gz}` in the same Release as a durability backup.
- **OGIM tiles**: `make ogim-upload` pushes to GCS manually (rarely re-run).
- **Worker**: `make worker-deploy` (separate from Pages).

**When adding new web assets**, add them to `scripts/dist.sh` (shared by `deploy.yml` and `update-data.yml`).
