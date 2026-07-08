# Firedamp

Methane plume aggregator with per-plume AI source attribution.

## Architecture

Static HTML/JS/CSS frontend (MapLibre GL, no build step, no npm) on GitHub Pages, a Python ETL pipeline that produces `plumes.bin`, an offline research agent that produces `attributions.json`, and a Cloudflare Worker (`firedamp-api`) with a D1 store of legacy vision-model analyses (now only read by `web/dataset.html`; the live map no longer calls it — see attribution below).

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

## Plume attribution (frontend)

The detail panel serves source attribution **solely** from the bulk agentic dataset (`web/data/attributions.json`, produced by `agent/` below). `web/analysis.js` looks the plume up by id and renders `source_label` (a fly-to link when `attributed_id` is an `OGIM:`/`OSM:` ref), `confidence`, `paragraph` and `evidence` links; a plume with no record shows "No source attribution yet." Daily-mean surface wind (Open-Meteo archive) is still fetched per plume as an independent panel stat, unrelated to attribution.

There is **no in-browser vision/LLM pipeline** any more. The old on-demand path — Overpass + Nominatim + Open-Meteo + an annotated Esri map (`captureAnnotatedMap`) sent to the Worker → OpenRouter, with a `↻` regenerate button and a D1 peek cache — was removed (git history has it). `attributions.json`, committed to git and reviewed in PRs, is the single source of truth. It stays a JSON blob rather than folding into `plumes.bin`: the records are sparse, variable-length, multilingual prose with URL arrays, a poor fit for the fixed-width `FDP1` record that CI rebuilds from CSV every 6 h.

`attributions.json` also drives map styling: `app.js` loads it (via `loadAttributions()` in `analysis.js`), and `addPlumeLayers` gives every plume whose id is in the set a semi-transparent fill in its source colour (`circle-opacity` case on an `attr` property) so attributed plumes read as filled discs against the hollow rings of the rest.

## Agentic attribution (`agent/`)

Bulk, offline attribution that supersedes the one-shot vision path for any plume it has covered: `agent/run.py` loops through plumes and runs a full research agent per plume — pi headless driving DeepSeek (`deepseek-v4-pro`, needs `DEEPSEEK_API_KEY`) with bash + web tools, no imagery. Results accumulate in `web/data/attributions.json` (committed to git; dist.sh copies it), which the frontend consults before falling back to the Worker path (`↻` still forces a live Worker run).

Per plume the driver assembles `context.json` from local data via `data/context.duckdb` (`make attr-db`, ~1 GB, rebuild after refreshing sources): OGIM v2.7 point layers + the containing O&G field, the OSM extract (`data/osm/*.csv`, wide radii keep named/high-signal features only), Global Coal Mine Tracker mines, the full 4-source detection history within 10–30 km (repeat detections are the strongest single signal), Open-Meteo daily-mean wind and a Nominatim place (both cached in `data/cache/`). Search radius scales with sensor uncertainty like the frontend `SENSORS` table, but wider (1.5–15 km).

The agent brief is `agent/task.md`: hypothesise from local evidence → research candidates on the web (`agent/bin/websearch` = DDG lite; `agent/bin/webget` = Jina reader with raw fallback; local-language searches encouraged) → cross-check against detection history → decide honestly, writing `result.json` with the Worker-compatible schema plus `source_name`, `operator`, `confidence`, `evidence` URLs. The driver validates `attributed_id` against the context (invented ids are nulled) before merging.

```
make attr-db                     # build data/context.duckdb
uv run agent/run.py <ids...>     # attribute specific plumes
uv run agent/run.py --top 50 --src sron -j 4
```

Already-attributed plumes are skipped unless `-f`. Full transcripts land in `agent/runs/<id>/log.json` (gitignored) — review them when iterating on the brief. ~5 min and ~1¢ per plume.

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
- `web/analysis.js` — static attribution lookup/render + wind stat.
- `web/util.js` — geometry + formatting helpers.
- `web/style.css` — glass-morphism dark UI, CMY source colours.
- `web/dataset.html` — AI dataset browser (in source, but not linked from the main UI and not copied into the Pages deploy yet; re-enable by uncommenting the subtitle link in `index.html` and adding it to `scripts/dist.sh`).

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
- **AI dataset snapshot**: `export-analyses.yml` runs daily (06:30 UTC), dumps `/api/analyses` to `analyses.json{,.gz}` in the same Release as a durability backup.
- **Private deploy**: `make deploy-private` — builds `plumes.bin` locally (pulling in the local-only, gitignored `data/ghgsat.csv`) and pushes the site to Cloudflare Pages project `firedamp-private` (`https://firedamp-private.pages.dev`), which sits behind Cloudflare Access (Zero Trust app "Firedamp private", "Data Desk" policy = the three datadesk.eco emails, covering prod + `*.pages.dev` previews). This is the **only** deploy that ever contains GHGSat: the target refuses to upload unless the Access gate is answering in front of the site, and the leaked CSV never touches GitHub. Manual snapshot — the public site refreshes every 6h, the private one only when re-run. The Worker's `/api/analyses` dump excludes `plume_src = 'ghgsat'` so private-site analyses stay out of the public dataset browser and daily snapshot.
- **OGIM tiles**: `make ogim-upload` pushes to GCS manually (rarely re-run).
- **Worker**: `make worker-deploy` (separate from Pages).

**When adding new web assets**, add them to `scripts/dist.sh` (shared by `deploy.yml` and `update-data.yml`).
