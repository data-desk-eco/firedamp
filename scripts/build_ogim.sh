#!/usr/bin/env bash
set -euo pipefail

OGIM_URL="https://zenodo.org/records/15103476/files/OGIM_v2.7.gpkg"
GPKG="data/OGIM_v2.7.gpkg"
OUT="web/data/ogim.pmtiles"

mkdir -p data web/data

# Download if not present
if [ ! -f "$GPKG" ]; then
    echo "Downloading OGIM v2.7 GeoPackage (3.1 GB)..."
    curl -L -o "$GPKG" "$OGIM_URL"
fi

# List layers
echo "Layers in OGIM:"
ogrinfo -so "$GPKG" | grep "^[0-9]"

# --- Extract layers to GeoJSONSeq ---
# Note: must include geom explicitly in SQL for GPKG → GeoJSONSeq

# Wells: exclude abandoned, plugged, dry holes, and junk types (~4.5M → ~1.5M)
echo "Extracting wells (filtered — excluding abandoned, plugged, dry holes)..."
ogr2ogr -f GeoJSONSeq data/ogim_wells.geojsonl "$GPKG" \
    -sql "SELECT geom, OGIM_ID, CATEGORY, COUNTRY, FAC_TYPE, OGIM_STATUS, OPERATOR, SUBSTR(SPUD_DATE, 1, 4) AS SPUD_YEAR
          FROM Oil_and_Natural_Gas_Wells
          WHERE geom IS NOT NULL
            AND OGIM_STATUS NOT IN ('ABANDONED', 'N/A')
            AND FAC_TYPE NOT IN ('N/A', 'DRY HOLE', 'UNKNOWN', '')
            AND FAC_TYPE NOT LIKE 'PLUGGED%'"

echo "Extracting pipelines..."
ogr2ogr -f GeoJSONSeq data/ogim_pipelines.geojsonl "$GPKG" \
    -sql "SELECT geom, OGIM_ID, CATEGORY, COUNTRY, FAC_TYPE, OGIM_STATUS, OPERATOR FROM Oil_Natural_Gas_Pipelines WHERE geom IS NOT NULL"

echo "Extracting facilities..."
> data/ogim_facilities.geojsonl
for layer in \
    Natural_Gas_Compressor_Stations \
    Gathering_and_Processing \
    LNG_Facilities \
    Crude_Oil_Refineries \
    Petroleum_Terminals \
    Offshore_Platforms \
    Stations_Other \
    Tank_Battery; do
    echo "  $layer..."
    ogr2ogr -f GeoJSONSeq /dev/stdout "$GPKG" \
        -sql "SELECT geom, OGIM_ID, CATEGORY, COUNTRY, FAC_TYPE, OGIM_STATUS, OPERATOR, FAC_NAME FROM ${layer} WHERE geom IS NOT NULL" \
        2>/dev/null >> data/ogim_facilities.geojsonl && echo "    OK" || echo "    skipped"
done

# --- Convert to PMTiles ---

echo "Building wells PMTiles..."
tippecanoe -o data/ogim_wells.pmtiles \
    --no-feature-limit \
    --no-tile-size-limit \
    --minimum-zoom=6 \
    --maximum-zoom=14 \
    --layer=wells \
    --force \
    data/ogim_wells.geojsonl

echo "Building pipelines PMTiles..."
tippecanoe -o data/ogim_pipelines.pmtiles \
    --no-feature-limit \
    --no-tile-size-limit \
    --minimum-zoom=6 \
    --maximum-zoom=14 \
    --layer=pipelines \
    --force \
    data/ogim_pipelines.geojsonl

if [ -s data/ogim_facilities.geojsonl ]; then
    echo "Building facilities PMTiles..."
    tippecanoe -o data/ogim_facilities.pmtiles \
        --no-feature-limit \
        --no-tile-size-limit \
        --minimum-zoom=6 \
        --maximum-zoom=14 \
        --layer=facilities \
        --force \
        data/ogim_facilities.geojsonl
fi

# Merge into single PMTiles
echo "Merging PMTiles..."
INPUTS="data/ogim_wells.pmtiles data/ogim_pipelines.pmtiles"
[ -f data/ogim_facilities.pmtiles ] && INPUTS="$INPUTS data/ogim_facilities.pmtiles"
tile-join -o "$OUT" --force --no-tile-size-limit $INPUTS

echo "Done! Output: $OUT"
ls -lh "$OUT"

# Clean up intermediate files
rm -f data/ogim_*.geojsonl data/ogim_*.pmtiles
