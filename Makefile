.PHONY: attr attr-db gaslight data ogim ogim-upload rebuild deploy-private serve vendor clean clean-all help

# ── Data pipeline ────────────────────────────────────────────────
# fetches are sentinel-cached: rm data/<source>.ok (or make clean) to refetch
data: data/sron.ok data/carbon_mapper.ok data/imeo.ok
	uv run scripts/build.py
	@echo "Built web/data/plumes.bin"

data/%.ok:
	uv run scripts/fetch_$*.py
	@touch $@

# ── OGIM infrastructure tiles ────────────────────────────────────
ogim: web/data/ogim.pmtiles

web/data/ogim.pmtiles: data/OGIM_v2.7.gpkg
	bash scripts/build_ogim.sh

# ── GCS upload ───────────────────────────────────────────────────
ogim-upload: web/data/ogim.pmtiles
	gcloud storage cp web/data/ogim.pmtiles gs://firedamp-data/ogim.pmtiles
	@echo "Uploaded to gs://firedamp-data/ogim.pmtiles"

# ── Full rebuild ─────────────────────────────────────────────────
rebuild: data ogim ogim-upload
	@echo "Full rebuild complete"

# ── Datadesk-only deploy (Cloudflare Pages behind Access) ────────
# ships the locally-built plumes.bin — including local-only ghgsat — so it
# refuses to deploy unless the access gate is answering in front of the site
deploy-private: data
	@curl -so /dev/null -w '%{redirect_url}' https://firedamp-private.pages.dev | grep -q cloudflareaccess.com || { echo "access gate is down — refusing to deploy"; exit 1; }
	bash scripts/dist.sh $$(git rev-parse HEAD)
	npx wrangler pages deploy dist --project-name firedamp-private --branch main

# ── Frontend ─────────────────────────────────────────────────────
vendor: web/vendor/.ok

web/vendor/.ok:
	bash scripts/vendor.sh
	@touch web/vendor/.ok

serve: vendor
	uv run scripts/serve.py

# ── Cleanup ──────────────────────────────────────────────────────
clean:
	rm -f data/*.ok data/*.csv web/data/plumes.bin

clean-all: clean
	rm -rf web/vendor data/sron data/OGIM_v2.7.gpkg web/data/ogim.pmtiles

help:
	@echo "make data          Fetch plume sources, build web/data/plumes.bin"
	@echo "make ogim          Build OGIM PMTiles from GeoPackage"
	@echo "make ogim-upload   Upload OGIM PMTiles to GCS"
	@echo "make rebuild       Full pipeline: data + ogim + upload"
	@echo "make deploy-private Deploy datadesk-only site (incl. GHGSat) to CF Pages"
	@echo "make vendor        Download vendored JS/CSS/fonts"
	@echo "make serve         Dev server on :8000"
	@echo "make clean         Remove generated data files"
	@echo "make clean-all     Remove all generated files including vendor"

# ── agentic attribution (agent/) ─────────────────────────────────
attr-db:
	uv run agent/run.py --init-db

# permian regulatory + flare-observation db from the sibling gaslight
# project's published release (data-desk-eco/gaslight, `make release` there)
gaslight:
	gh release download db-latest --repo data-desk-eco/gaslight \
		--pattern gaslight.duckdb --dir data --clobber
	@echo "Fetched data/gaslight.duckdb"

attr:
	uv run agent/run.py --top 20 -j 4
