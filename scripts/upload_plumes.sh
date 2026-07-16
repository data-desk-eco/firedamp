#!/usr/bin/env bash
# upload web/data/plumes.parquet to the central datadesk store
# (plumes/data.parquet, public) — the url the deployed site reads live.
# refuses a parquet carrying ghgsat rows: those are private-deploy-only and
# must never be published (ci never has ghgsat.csv; a local build may).
# creds: static env aws keys (ci) or the s2-flares store helper (local).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=web/data/plumes.parquet
[ -f "$SRC" ] || { echo "missing $SRC — run 'make data' first"; exit 1; }
[ "$(duckdb -noheader -list -c "select count(*) from read_parquet('$SRC') where src='ghgsat'")" = 0 ] \
    || { echo "refusing to publish: $SRC contains ghgsat (private) rows — ci publishes the public build"; exit 1; }

store=${S2FLARES:-$HOME/Tools/s2-flares}/cloud/store.sh
if [ -f "$store" ]; then . "$store"; store_creds
else STORE_BUCKET=datadesk-archive; STORE_ENDPOINT=https://s3.WAW3-2.cloudferro.com; fi

aws --endpoint-url "$STORE_ENDPOINT" s3 cp "$SRC" "s3://$STORE_BUCKET/plumes/data.parquet" --no-progress
echo "published: $STORE_ENDPOINT/$STORE_BUCKET/plumes/data.parquet"
