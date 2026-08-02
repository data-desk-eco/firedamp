.PHONY: deploy deploy-private serve vendor clean clean-all help

# plume aggregation etl (carbon mapper / imeo / sron / dd, 6-hourly publish to
# the store) lives in ~/Tools/etl now; the deployed site reads each provider's
# year-partitioned plume table live. this repo only builds and deploys the map.
ETL ?= $(HOME)/Tools/etl

# ── Deploy ───────────────────────────────────────────────────────
# public (push → pages workflow) + private together, so they never drift
deploy: deploy-private
	git push

# ── Datadesk-only deploy (Cloudflare Pages behind Access) ────────
# bakes an etl-built plumes.parquet — including local-only ghgsat and our own
# dd detections — so it refuses to deploy unless the access gate is answering
deploy-private:
	@curl -so /dev/null -w '%{redirect_url}' https://firedamp-private.pages.dev | grep -q cloudflareaccess.com || { echo "access gate is down — refusing to deploy"; exit 1; }
	$(MAKE) -C $(ETL) carbon-mapper sron imeo data-desk ghgsat
	@mkdir -p web/data
	duckdb -c "COPY (FROM read_parquet(['$(ETL)/data/carbon-mapper/plumes/*/*.parquet','$(ETL)/data/sron/plumes/*/*.parquet','$(ETL)/data/imeo/plumes/*/*.parquet','$(ETL)/data/data-desk/plumes/*/*.parquet','$(ETL)/data/ghgsat/private/plumes/*/*.parquet'], union_by_name=true)) TO 'web/data/plumes.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"
	cp $(ETL)/data/mapstand/private/licences/data.parquet web/data/licences.parquet
	bash scripts/dist.sh $$(git rev-parse HEAD) local
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
	rm -f web/data/plumes.parquet web/data/licences.parquet

clean-all: clean
	rm -rf web/vendor

help:
	@echo "make deploy        Deploy private + push (public deploys via Actions)"
	@echo "make deploy-private Deploy datadesk-only site (incl. GHGSat) to CF Pages"
	@echo "make vendor        Download vendored JS/CSS/fonts"
	@echo "make serve         Dev server on :8000"
	@echo "plume etl lives in ~/Tools/etl now (make -C ../etl help)"
