.PHONY: data plumes-upload deploy deploy-private serve vendor clean clean-all help

# ── Data pipeline ────────────────────────────────────────────────
# fetches are sentinel-cached: rm data/<source>.ok (or make clean) to refetch
data: data/sron.ok data/carbon_mapper.ok data/imeo.ok
	uv run scripts/build.py

data/%.ok:
	uv run scripts/fetch_$*.py
	@touch $@

# ── Publish plumes to the central datadesk store ──────────────────
# the deployed site reads plumes/data.parquet live from the store; ci
# (update-data.yml) publishes 6-hourly, this is the manual path. the ch4id
# feature catalogue (features/data.fgb) is published by ch4id: make -C
# ~/Tools/ch4id features
plumes-upload: data
	bash scripts/upload_plumes.sh

# ── Deploy ───────────────────────────────────────────────────────
# public (push → pages workflow) + private together, so they never drift
deploy: deploy-private
	git push

# ── Datadesk-only deploy (Cloudflare Pages behind Access) ────────
# bakes the locally-built plumes.parquet — including local-only ghgsat — so it
# refuses to deploy unless the access gate is answering in front of the site
deploy-private: data
	@curl -so /dev/null -w '%{redirect_url}' https://firedamp-private.pages.dev | grep -q cloudflareaccess.com || { echo "access gate is down — refusing to deploy"; exit 1; }
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
# only the refetchable csvs: ghgsat.csv (local-only) and gcmt_coal.csv
# (manual download) are irreplaceable
clean:
	rm -f data/*.ok data/carbon_mapper.csv data/imeo_plumes.csv data/sron_all.csv web/data/plumes.parquet

clean-all: clean
	rm -rf web/vendor data/sron

help:
	@echo "make data          Fetch plume sources, build web/data/plumes.parquet"
	@echo "make plumes-upload Publish plumes.parquet to the central datadesk store"
	@echo "make deploy        Deploy private + push (public deploys via Actions)"
	@echo "make deploy-private Deploy datadesk-only site (incl. GHGSat) to CF Pages"
	@echo "make vendor        Download vendored JS/CSS/fonts"
	@echo "make serve         Dev server on :8000"
	@echo "make clean         Remove generated data files"
	@echo "make clean-all     Remove all generated files including vendor"
