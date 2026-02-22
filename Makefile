.PHONY: data ogim ogim-upload rebuild serve vendor clean clean-all help

# ── Data pipeline ────────────────────────────────────────────────
data: data/sron.ok data/carbon_mapper.ok
	uv run scripts/build.py
	@echo "Built web/data/plumes.bin"

data/sron.ok:
	uv run scripts/fetch_sron.py
	@touch data/sron.ok

data/carbon_mapper.ok:
	uv run scripts/fetch_carbon_mapper.py
	@touch data/carbon_mapper.ok

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
	@echo "make clean         Remove generated data files"
	@echo "make clean-all     Remove all generated files including vendor"
