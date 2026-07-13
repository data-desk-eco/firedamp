#!/usr/bin/env bash
# vendor dependencies into web/vendor: everything cartograph needs (maplibre,
# duckdb-wasm, inter, dd design system, cartograph itself) plus firedamp's
# flatgeobuf (http-range bbox queries over features.fgb).
set -euo pipefail

CARTOGRAPH="${CARTOGRAPH:-$HOME/Tools/cartograph}"
bash "$CARTOGRAPH/scripts/vendor.sh" web/vendor

echo "flatgeobuf@4.4.0 ..."
curl -sLo web/vendor/flatgeobuf-geojson.min.js "https://unpkg.com/flatgeobuf@4.4.0/dist/flatgeobuf-geojson.min.js"
