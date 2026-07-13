#!/usr/bin/env bash
# assemble the pages artifact in dist/, cache-busting js/css with the git sha.
# used by deploy.yml and update-data.yml: bash scripts/dist.sh "$GITHUB_SHA"
set -euo pipefail

V="${1:-dev}"; V="${V:0:8}"
rm -rf dist
mkdir -p dist/data
cp web/index.html web/style.css web/*.js dist/
cp -r web/vendor dist/vendor
cp web/data/plumes.parquet web/data/attributions.parquet dist/data/

# bust the entry points in index.html, the app-local es-module import graph
# (vendor modules stay unbusted so each resolves to one url = one instance),
# and the parquet fetches
sed -i.bak -E "s#(config\.js|\"style\.css)#\1?v=$V#g" dist/index.html
sed -i.bak -E "s#(from '\./[a-z]+\.js)'#\1?v=$V'#g" dist/*.js
sed -i.bak -E "s#(data/(plumes|attributions)\.parquet)#\1?v=$V#g" dist/config.js
rm dist/*.bak
