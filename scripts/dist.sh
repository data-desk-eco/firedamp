#!/usr/bin/env bash
# assemble the pages artifact in dist/, cache-busting js/css with the git sha.
# used by deploy.yml and update-data.yml: bash scripts/dist.sh "$GITHUB_SHA"
set -euo pipefail

V="${1:-dev}"; V="${V:0:8}"
rm -rf dist
mkdir -p dist/data
cp web/index.html web/style.css web/*.js dist/
cp -r web/vendor dist/vendor
cp web/data/plumes.bin dist/data/
uv run scripts/build_attr.py   # attributions.parquet (git) → FDA1 binary
cp web/data/attributions.bin dist/data/

# bust the entry points in index.html, the es-module import graph, and the
# attribution binary fetch
sed -i.bak -E "s#(app\.js|style\.css)#\1?v=$V#g" dist/index.html
sed -i.bak -E "s#(from '\./[a-z]+\.js)'#\1?v=$V'#g" dist/*.js
sed -i.bak -E "s#(data/attributions\.bin)#\1?v=$V#g" dist/analysis.js
rm dist/*.bak
