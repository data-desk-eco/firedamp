#!/usr/bin/env bash
# vendor dependencies into web/vendor: everything cartograph needs (maplibre,
# DuckDB, Inter, the Data Desk design system, and Cartograph).
set -euo pipefail

CARTOGRAPH="${CARTOGRAPH:-$HOME/Tools/cartograph}"
bash "$CARTOGRAPH/scripts/vendor.sh" web/vendor
# h3 names the cell an infrastructure object is partitioned on
curl -sLo web/vendor/h3-js.es.js https://unpkg.com/h3-js@4.2.1/dist/h3-js.es.js
