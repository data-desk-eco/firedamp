.PHONY: data ogim ogim-upload rebuild serve vendor clean help

# ── Data pipeline ────────────────────────────────────────────────
data: data/imeo.ok data/sron.ok data/carbon_mapper.ok
	uv run scripts/build.py
	@echo "Built web/data/plumes.json"

data/imeo.ok:
	uv run scripts/fetch_imeo.py
	@touch data/imeo.ok

data/sron.ok:
	uv run scripts/fetch_sron.py
	@touch data/sron.ok

data/carbon_mapper.ok:
	uv run scripts/fetch_carbon_mapper.py
	@touch data/carbon_mapper.ok

# ── OGIM infrastructure tiles ────────────────────────────────────
ogim: web/data/ogim.pmtiles

web/data/ogim.pmtiles:
	@bash scripts/build_ogim.sh

# ── OGIM GCS upload ─────────────────────────────────────────────
ogim-upload: web/data/ogim.pmtiles
	gcloud storage cp web/data/ogim.pmtiles gs://firedamp-data/ogim.pmtiles
	@echo "Uploaded to gs://firedamp-data/ogim.pmtiles"

# ── Full rebuild (data + OGIM + upload) ─────────────────────────
rebuild: data ogim ogim-upload
	@echo "Full rebuild complete — commit and push to deploy"

# ── Frontend ─────────────────────────────────────────────────────
vendor: web/vendor/.ok

web/vendor/.ok:
	@bash scripts/vendor.sh
	@touch web/vendor/.ok

serve: vendor
	@python3 scripts/serve.py

# ── Cleanup ──────────────────────────────────────────────────────
clean:
	rm -rf data/*.ok data/*.csv data/*.json data/*.geojson web/data/*.json web/data/*.pmtiles

clean-all: clean
	rm -rf web/vendor

help:
	@echo "make data        - Fetch all plume datasets and build JSON"
	@echo "make ogim        - Build OGIM infrastructure PMTiles"
	@echo "make ogim-upload - Upload OGIM PMTiles to GCS"
	@echo "make rebuild     - Full rebuild (data + OGIM + upload)"
	@echo "make vendor      - Download vendored dependencies (MapLibre, Inter)"
	@echo "make serve       - Dev server on :8000"
	@echo "make clean       - Remove generated data"
	@echo "make clean-all   - Remove everything including vendor"
