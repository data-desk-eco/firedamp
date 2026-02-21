# Methane Plume Visualisation

Full-screen map showing methane plume detections from three satellite datasets alongside infrastructure data, styled after [burnoff](~/Tools/burnoff) with attribution logic inspired by [nom-de-plume](~/nom-de-plume). Static HTML/JS/CSS with JSON data, deployable to GitHub Pages.

## Architecture

```
methane/
├── Makefile                    # Build targets: data, vendor, serve, clean
├── pyproject.toml              # Python deps (httpx only)
├── scripts/
│   ├── fetch_carbon_mapper.py  # Carbon Mapper API → data/carbon_mapper.csv
│   ├── fetch_imeo.py           # Verify existing IMEO data in plumes_data/
│   ├── fetch_sron.py           # SRON FTP CSVs → data/sron_all.csv
│   ├── build.py                # Merge all sources → web/data/*.json
│   └── vendor.sh               # Download MapLibre GL + Inter font
├── web/
│   ├── index.html              # Full-screen map with glass panels
│   ├── style.css               # Burnoff-style glass-morphism
│   ├── app.js                  # MapLibre GL, data loading, interactions
│   ├── data/                   # Generated JSON (gitignored)
│   │   ├── plumes.json         # All plumes from all 3 sources
│   │   └── sources.json        # IMEO recurring emission sources
│   └── vendor/                 # Vendored JS/CSS (gitignored)
│       ├── maplibre-gl.js
│       ├── maplibre-gl.css
│       └── fonts/
├── data/                       # Raw downloads (gitignored)
│   ├── carbon_mapper.csv
│   ├── sron/                   # Individual SRON weekly CSVs
│   └── sron_all.csv            # Concatenated SRON data
└── plumes_data/                # Already downloaded IMEO GeoJSON
    ├── unep_methanedata_detected_plumes.geojson   (22,465 features)
    └── unep_methanedata_detected_sources.geojson   (3,125 features)
```

## Data Sources

### 1. Carbon Mapper (`src: "cm"`)
- **API**: `https://api.carbonmapper.org/api/v1/catalog/plume-csv?gas=CH4`
- **Format**: CSV with lat, lon, emission_auto (kg/hr), emission_uncertainty_auto, datetime, platform, ipcc_sector
- **Coverage**: Global, ~10K plumes, Tanager-1 satellite
- **Sector field**: `ipcc_sector` e.g. "Oil & Gas (1B2)"

### 2. IMEO/MARS (`src: "imeo"`)
- **Already downloaded** to `plumes_data/`
- **Plumes**: 22,465 GeoJSON features with MultiPolygon geometry (drop polygons, keep lat/lon points)
- **Sources**: 3,125 GeoJSON Point features (recurring emission locations)
- **Fields**: ch4_fluxrate (kg/hr), ch4_fluxrate_std, satellite, sector, country, source_name
- **Satellites**: EMIT, TROPOMI, Sentinel-2, Landsat 8/9, EnMAP, PRISMA, VIIRS
- **Sectors**: "Oil and Gas", "Coal", "Waste", "Other"

### 3. SRON TROPOMI (`src: "sron"`)
- **FTP**: `https://ftp.sron.nl/pub/memo/CSVs/` — browsable HTML directory listing
- **Format**: Weekly CSVs, pattern `SRON_Weekly_Methane_Plumes_YYYY_wkWW_vYYYYMMDD.csv`
- **Fields**: date (YYYYMMDD), time_UTC, lat, lon, source_rate_t/h, uncertainty_t/h
- **Coverage**: Global, ~8K plumes since 2023, weekly releases
- **Note**: Rates in tonnes/hr — multiply by 1000 for kg/hr

## Data Contract

### `web/data/plumes.json`
```json
{
  "meta": {
    "generated": "2026-02-21T00:00:00Z",
    "counts": { "cm": 10000, "imeo": 22000, "sron": 8000 }
  },
  "plumes": [
    {
      "id": "uuid-or-generated",
      "src": "cm",
      "lat": 31.5,
      "lon": -103.2,
      "dt": "2025-06-15",
      "rate": 1500,
      "unc": 300,
      "sat": "Tanager-1",
      "sec": "og",
      "cty": "US"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID (CM: plume_id, IMEO: id_plume UUID, SRON: generated hash) |
| `src` | string | Source: `"cm"`, `"imeo"`, `"sron"` |
| `lat` | float | Latitude |
| `lon` | float | Longitude |
| `dt` | string | Date YYYY-MM-DD |
| `rate` | float | Emission rate kg/hr |
| `unc` | float\|null | Uncertainty kg/hr |
| `sat` | string | Satellite (short name) |
| `sec` | string\|null | Sector: `"og"`, `"coal"`, `"waste"`, `"other"`, null |
| `cty` | string\|null | ISO 3166-1 alpha-2 country code |

Satellite short names: `"Tanager-1"`, `"EMIT"`, `"S2"`, `"S5P"`, `"L8"`, `"L9"`, `"EnMAP"`, `"PRISMA"`, `"TROPOMI"`, `"VIIRS"`

Sector mapping:
- `"Oil and Gas"` / `"Oil & Gas (1B2)"` → `"og"`
- `"Coal"` / `"Met Coal"` / `"Thermal Coal"` / `"Thermal and Met Coal"` → `"coal"`
- `"Waste"` → `"waste"`
- Everything else → `"other"`

### `web/data/sources.json`
```json
[
  {
    "id": "US_S_001",
    "lat": 31.5,
    "lon": -103.2,
    "cty": "US",
    "sec": "og",
    "n": 15,
    "persist": "frequent",
    "last": "2025-12-01"
  }
]
```

## Frontend Design (Burnoff Style)

### Map
- **Library**: MapLibre GL v5.1.0 (vendored, no npm)
- **Tiles**: ArcGIS World Imagery raster, desaturated to grayscale
  - `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
  - Style: saturation -1, brightness max 0.85
- **Projection**: Globe
- **Initial view**: Center [0, 20], zoom 2.5 (global view)
- **Controls**: Hide default MapLibre controls

### Plume Rendering
- Circle layers, one per source (cm, imeo, sron) for independent toggling
- **Color by source**: CM = `#22d3ee` (cyan), IMEO = `#f97316` (orange), SRON = `#a855f7` (purple)
- **Radius by emission rate**: data-driven, interpolate log scale
  - < 500 kg/hr → 3px
  - 1000 kg/hr → 5px
  - 5000 kg/hr → 8px
  - 10000+ kg/hr → 12px
- **Opacity**: 0.7 base, 0.9 on hover
- IMEO sources rendered as small diamond markers (separate layer, toggleable)

### UI Panels (Glass-morphism)

Following burnoff exactly:
- `backdrop-filter: blur(12px)`, `background: rgba(0,0,0,0.75)`
- Border: `1px solid rgba(255,255,255,0.08)`
- Font: Inter, scale 10/11/13px
- Color: white text, `rgba(255,120,50,0.9)` accent

#### Left Panel (220px, top-left)
- **Title**: "methane" (h1, 13px, weight 500)
- **Subtitle**: "Satellite plume detections" (11px, muted)
- **Source toggles**: 3 buttons (CM / IMEO / SRON) — burnoff mode-toggle style
  - Each shows count badge
  - Active state: colored background matching source color
- **Separator**
- **Stats section**:
  - Total visible plumes count
  - Date range of visible data
- **Sector filter**: 4 buttons (All / O&G / Coal / Waste)
- **Date range**: Year buttons (2020-2026) or a simple range slider
- **Collapsible** (chevron toggle, same as burnoff)

#### Right Panel (300px, top-right) — Detail Panel
- Hidden by default, shown on plume click
- **Header**: Plume ID (truncated), coordinates, close button
- **Stats grid** (2x2):
  - Emission rate (large number + "kg/hr")
  - Uncertainty
  - Satellite
  - Date
- **Source badge**: colored pill showing CM/IMEO/SRON
- **Sector**: if available
- **Country**: if available
- **Nearby sources**: if clicking near an IMEO source, show source persistence info

#### Bottom-Left Legend
- Source colors (3 circles with labels)
- Size scale (3 circles: small/medium/large with rate labels)
- IMEO sources marker

#### Bottom-Right
- Data Desk logo (SVG, links to datadesk.eco)

### Interactions
- **Hover**: Highlight plume, show tooltip with rate + source
- **Click**: Open detail panel, fly to plume location
- **Source toggles**: Show/hide layers
- **Sector filter**: Filter plumes by sector
- **Date filter**: Filter plumes by year

### Mobile Responsive
- Left panel: top-left, narrower
- Detail panel: bottom sheet (full width, max 45vh)
- Legend: top-right
- Logo: hidden

## Build Pipeline

### Makefile Targets
```makefile
make data       # Run all fetch scripts + build.py → web/data/*.json
make vendor     # vendor.sh → web/vendor/ (MapLibre GL + Inter font)
make serve      # python3 -m http.server 8000 -d web
make clean      # Remove generated data
make clean-all  # Remove vendor too
```

### vendor.sh
Download (curl) into `web/vendor/`:
- `maplibre-gl.js` + `maplibre-gl.css` from unpkg (v5.1.0)
- Inter font (latin subset from Google Fonts) — same approach as burnoff

No DuckDB, no geotiff.js — this project is simpler.

### Data Pipeline Flow
```
make data
  ├── scripts/fetch_carbon_mapper.py  →  data/carbon_mapper.csv
  ├── scripts/fetch_imeo.py           →  (verify plumes_data/ exists)
  ├── scripts/fetch_sron.py           →  data/sron_all.csv
  └── scripts/build.py                →  web/data/plumes.json
                                          web/data/sources.json
```

## Agent Team Structure

### Team: `methane-build`

#### Agent 1: `data-pipeline` (general-purpose)
Writes all Python scripts and the Makefile:
- `scripts/fetch_carbon_mapper.py`
- `scripts/fetch_imeo.py`
- `scripts/fetch_sron.py`
- `scripts/build.py`
- Update `Makefile` (already scaffolded)
- Update `pyproject.toml` if needed

Must use: httpx, pathlib, json, csv (stdlib). No other deps.

#### Agent 2: `frontend` (general-purpose)
Writes all web files:
- `scripts/vendor.sh`
- `web/index.html`
- `web/style.css`
- `web/app.js`

Must follow burnoff patterns exactly for styling. Uses vendored MapLibre GL. Reads the data contract above for JSON format. Can work entirely from the data contract — does not need real data.

#### Agent 3: `integration` (general-purpose)
After agents 1 and 2 complete:
- Run `make vendor` to download dependencies
- Run `make data` to fetch and build data
- Run `make serve` and verify the map works
- Fix any integration issues
- Run a final check

### Task Dependencies
```
[data-pipeline] ──────┐
                       ├──→ [integration]
[frontend] ───────────┘
```

Data-pipeline and frontend run in parallel. Integration runs after both complete.

## Key Reference Patterns

### From burnoff (~/Tools/burnoff)
- `web/style.css`: Full glass-morphism CSS (714 lines) — copy design system verbatim
- `web/index.html`: Panel structure, vendor script loading, importmap
- `scripts/vendor.sh`: MapLibre + font vendoring pattern
- `Makefile`: Make-based build with uv for Python

### From nom-de-plume (~/nom-de-plume)
- `scripts/fetch_emissions.py`: Carbon Mapper API fetching pattern
- `queries/create_attribution.sql`: Attribution via spatial proximity (1.5km radius)
- Data export patterns: slim JSON with only essential fields

## ISO 3166 Alpha-3 → Alpha-2 Mapping

Include in build.py for converting IMEO source_name prefixes:

```python
ISO3_TO_2 = {
    "ARG": "AR", "DZA": "DZ", "USA": "US", "TKM": "TM", "IRN": "IR",
    "CHN": "CN", "RUS": "RU", "KAZ": "KZ", "IRQ": "IQ", "LBY": "LY",
    "MEX": "MX", "IND": "IN", "PAK": "PK", "UZB": "UZ", "EGY": "EG",
    "NGA": "NG", "VEN": "VE", "SAU": "SA", "ARE": "AE", "OMN": "OM",
    "BGD": "BD", "MYS": "MY", "IDN": "ID", "AUS": "AU", "CAN": "CA",
    "BRA": "BR", "COL": "CO", "PER": "PE", "BOL": "BO", "ECU": "EC",
    "TTO": "TT", "GHA": "GH", "CIV": "CI", "CMR": "CM", "TCD": "TD",
    "AGO": "AO", "MOZ": "MZ", "TZA": "TZ", "KEN": "KE", "ETH": "ET",
    "SDN": "SD", "TUN": "TN", "MAR": "MA", "POL": "PL", "DEU": "DE",
    "GBR": "GB", "NLD": "NL", "FRA": "FR", "ITA": "IT", "ESP": "ES",
    "ROU": "RO", "UKR": "UA", "BLR": "BY", "GEO": "GE", "AZE": "AZ",
    "TUR": "TR", "SYR": "SY", "JOR": "JO", "PSE": "PS", "ISR": "IL",
    "LBN": "LB", "YEM": "YE", "KWT": "KW", "BHR": "BH", "QAT": "QA",
    "MMR": "MM", "THA": "TH", "VNM": "VN", "PHL": "PH", "JPN": "JP",
    "KOR": "KR", "TWN": "TW", "MNG": "MN", "AFG": "AF", "SRB": "RS",
    "BGR": "BG", "CZE": "CZ", "SVK": "SK", "HUN": "HU", "HRV": "HR",
    "BIH": "BA", "ALB": "AL", "MKD": "MK", "GRC": "GR", "CYP": "CY",
    "LKA": "LK", "NPL": "NP", "LAO": "LA", "KHM": "KH", "PNG": "PG",
    "NZL": "NZ", "CHL": "CL", "PRY": "PY", "URY": "UY", "GUY": "GY",
    "SUR": "SR", "GTM": "GT", "HND": "HN", "NIC": "NI", "CRI": "CR",
    "PAN": "PA", "CUB": "CU", "DOM": "DO", "SEN": "SN", "MLI": "ML",
    "BFA": "BF", "NER": "NE", "BEN": "BJ", "TGO": "TG", "LBR": "LR",
    "SLE": "SL", "GIN": "GN", "GAB": "GA", "COG": "CG", "COD": "CD",
    "ZMB": "ZM", "ZWE": "ZW", "BWA": "BW", "NAM": "NA", "ZAF": "ZA",
    "MDG": "MG", "MWI": "MW", "RWA": "RW", "UGA": "UG", "SOM": "SO",
    "ERI": "ER", "NOR": "NO", "SWE": "SE", "FIN": "FI", "DNK": "DK",
    "IRL": "IE", "PRT": "PT", "AUT": "AT", "CHE": "CH", "BEL": "BE",
}
```
