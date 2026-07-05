#!/usr/bin/env bash
# assemble the pages artifact in dist/, cache-busting js/css with the git sha.
# used by deploy.yml and update-data.yml: bash scripts/dist.sh "$GITHUB_SHA"
# dataset.html is intentionally not deployed yet (kept in source).
set -euo pipefail

V="${1:-dev}"; V="${V:0:8}"
rm -rf dist
mkdir -p dist/data
cp web/index.html web/style.css web/*.js dist/
cp -r web/vendor dist/vendor
cp web/data/plumes.bin dist/data/

# bust the entry points in index.html and the es-module import graph
sed -i.bak -E "s#(app\.js|style\.css)#\1?v=$V#g" dist/index.html
sed -i.bak -E "s#(from '\./[a-z]+\.js)'#\1?v=$V'#g" dist/*.js
rm dist/*.bak
