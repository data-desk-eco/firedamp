.PHONY: data features features-upload rebuild deploy-private serve vendor clean clean-all help

CH4ID ?= $(HOME)/Tools/ch4id

# ── Data pipeline ────────────────────────────────────────────────
# fetches are sentinel-cached: rm data/<source>.ok (or make clean) to refetch
data: data/sron.ok data/carbon_mapper.ok data/imeo.ok
	uv run scripts/build.py

data/%.ok:
	uv run scripts/fetch_$*.py
	@touch $@

# ── ch4id feature catalogue (candidate sources) ──────────────────
features: web/data/features.fgb

web/data/features.fgb: $(CH4ID)/data/features.parquet scripts/features.sql
	CH4ID=$(CH4ID) OUT=$@ duckdb -bail < scripts/features.sql

features-upload: web/data/features.fgb
	gcloud storage cp web/data/features.fgb gs://firedamp-data/features.fgb
	@echo "Uploaded to gs://firedamp-data/features.fgb"

# ── Full rebuild ─────────────────────────────────────────────────
rebuild: data features features-upload
	@echo "Full rebuild complete"

# ── Datadesk-only deploy (Cloudflare Pages behind Access) ────────
# ships the locally-built plumes.parquet — including local-only ghgsat — so it
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
# only the refetchable csvs: ghgsat.csv (local-only) and gcmt_coal.csv
# (manual download) are irreplaceable
clean:
	rm -f data/*.ok data/carbon_mapper.csv data/imeo_plumes.csv data/sron_all.csv web/data/plumes.parquet

clean-all: clean
	rm -rf web/vendor data/sron web/data/features.fgb

help:
	@echo "make data          Fetch plume sources, build web/data/plumes.parquet"
	@echo "make features      Build features.fgb from the ch4id catalogue"
	@echo "make features-upload Upload features.fgb to GCS"
	@echo "make rebuild       Full pipeline: data + features + upload"
	@echo "make deploy-private Deploy datadesk-only site (incl. GHGSat) to CF Pages"
	@echo "make vendor        Download vendored JS/CSS/fonts"
	@echo "make serve         Dev server on :8000"
	@echo "make clean         Remove generated data files"
	@echo "make clean-all     Remove all generated files including vendor"
