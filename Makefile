.PHONY: data ogim ogim-upload rebuild serve vendor worker-dev worker-deploy worker-schema worker-tail clean clean-all help

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

# ── Frontend ─────────────────────────────────────────────────────
vendor: web/vendor/.ok

web/vendor/.ok:
	bash scripts/vendor.sh
	@touch web/vendor/.ok

serve: vendor
	uv run scripts/serve.py

# ── Cloudflare Worker (firedamp-api) ─────────────────────────────
worker-dev:
	cd worker && npx wrangler dev

worker-deploy:
	cd worker && npx wrangler deploy

worker-schema:
	cd worker && npx wrangler d1 execute firedamp-analyses --file schema.sql --remote

worker-tail:
	cd worker && npx wrangler tail

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
	@echo "make vendor        Download vendored JS/CSS/fonts"
	@echo "make serve         Dev server on :8000"
	@echo "make worker-dev    wrangler dev for the firedamp-api Worker"
	@echo "make worker-deploy wrangler deploy"
	@echo "make worker-schema Apply worker/schema.sql to the remote D1"
	@echo "make worker-tail   Tail Worker logs"
	@echo "make clean         Remove generated data files"
	@echo "make clean-all     Remove all generated files including vendor"
