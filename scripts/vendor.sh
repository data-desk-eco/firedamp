#!/usr/bin/env bash
# Download vendored dependencies into web/vendor/.
# Run via: make vendor
set -euo pipefail

VENDOR="web/vendor"
rm -rf "$VENDOR"
mkdir -p "$VENDOR/fonts"

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

# ── MapLibre GL 5.1.0 ──────────────────────────────────────────────
echo "maplibre-gl@5.1.0 ..."
curl -sLo "$VENDOR/maplibre-gl.js"  "https://unpkg.com/maplibre-gl@5.1.0/dist/maplibre-gl.js"
curl -sLo "$VENDOR/maplibre-gl.css" "https://unpkg.com/maplibre-gl@5.1.0/dist/maplibre-gl.css"

# ── FlatGeobuf 4.4.0 (http-range bbox queries over features.fgb) ───
echo "flatgeobuf@4.4.0 ..."
curl -sLo "$VENDOR/flatgeobuf-geojson.min.js" "https://unpkg.com/flatgeobuf@4.4.0/dist/flatgeobuf-geojson.min.js"

# ── Inter font (latin subset from Google Fonts) ────────────────────
echo "inter font ..."
FONTS_CSS=$(curl -sH "User-Agent: $UA" \
  "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400..500;1,14..32,400..500&display=swap")

# Use python to reliably parse the CSS, extract latin @font-face blocks,
# download font files, and emit local CSS
python3 -c "
import re, urllib.request, sys

css = sys.stdin.read()
# Split into @font-face blocks with their subset comments
blocks = re.split(r'(?=/\*)', css)
local_css = ''
i = 0
for block in blocks:
    if not block.strip().startswith('/* latin */'):
        continue
    url = re.search(r'url\((https://[^)]+\.woff2)\)', block)
    if not url:
        continue
    fname = f'inter-latin-{i}.woff2'
    urllib.request.urlretrieve(url.group(1), f'$VENDOR/fonts/{fname}')
    local_block = block.replace(url.group(1), f'vendor/fonts/{fname}')
    local_css += local_block + '\n'
    i += 1

with open('$VENDOR/fonts/inter.css', 'w') as f:
    f.write(local_css)
print(f'  {i} latin font files')
" <<< "$FONTS_CSS"

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "Vendored to $VENDOR/:"
du -sh "$VENDOR/maplibre-gl.js" "$VENDOR/maplibre-gl.css" "$VENDOR/flatgeobuf-geojson.min.js"
du -sh "$VENDOR/fonts/"*
echo ""
echo "Total: $(du -sh "$VENDOR" | cut -f1)"
