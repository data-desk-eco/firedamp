# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow"]
# ///
import csv
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

SAT_SHORT = {
    "EMIT - NASA": "EMIT",
    "EnMAP - DLR": "EnMAP",
    "PRISMA - ASI": "PRISMA",
    "Sentinel-2 - ESA": "S2",
    "Sentinel-3 - ESA": "S3",
    "Sentinel-5P/TROPOMI - ESA": "TROPOMI",
    "VIIRS - NASA/NOAA": "VIIRS",
    "Landsat - NASA/USGS": "L8",
    "GOES - NOAA": "GOES",
}

def map_sector(raw):
    if not raw:
        return None
    low = raw.lower()
    if "oil" in low or "gas" in low:
        return "og"
    if "coal" in low:
        return "coal"
    if "waste" in low:
        return "waste"
    return "other"


def safe_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def build_cm(path):
    plumes = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("gas", "").upper() != "CH4":
                continue

            dt = row.get("datetime", "")[:10] or None

            # keep rate-less plumes: cm publishes some without a quantified rate
            rate = safe_float(row.get("emission_auto"))
            unc = safe_float(row.get("emission_uncertainty_auto"))
            plumes.append({
                "id": row.get("plume_id", ""),
                "src": "cm",
                "lat": round(safe_float(row.get("plume_latitude")), 4),
                "lon": round(safe_float(row.get("plume_longitude")), 4),
                "dt": dt,
                "rate": round(rate) if rate is not None else None,
                "unc": round(unc) if unc is not None else None,
                "sat": row.get("platform", "Tanager-1"),
                "sec": map_sector(row.get("ipcc_sector")),
            })
    print(f"  CM: {len(plumes)} plumes")
    return plumes


def build_imeo_plumes(path):
    plumes = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rate = safe_float(row.get("ch4_fluxrate"))
            dt_raw = row.get("tile_date", "")
            dt = dt_raw[:10] if dt_raw else None

            sat_raw = row.get("satellite", "")
            sat = SAT_SHORT.get(sat_raw, sat_raw)

            unc = safe_float(row.get("ch4_fluxrate_std"))
            plumes.append({
                "id": row.get("id_plume", ""),
                "src": "imeo",
                "lat": round(safe_float(row.get("lat")), 4),
                "lon": round(safe_float(row.get("lon")), 4),
                "dt": dt,
                "rate": round(rate) if rate is not None else None,
                "unc": round(unc) if unc is not None else None,
                "sat": sat,
                "sec": map_sector(row.get("sector")),
            })
    print(f"  IMEO: {len(plumes)} plumes")
    return plumes


def build_sron(path):
    plumes = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            dt_raw = row.get("date", "")
            if len(dt_raw) == 8 and dt_raw.isdigit():
                dt = f"{dt_raw[:4]}-{dt_raw[4:6]}-{dt_raw[6:8]}"
            else:
                dt = dt_raw[:10] if dt_raw else None

            rate_t = safe_float(row.get("source_rate_t/h"))
            rate = rate_t * 1000 if rate_t is not None else None

            unc_t = safe_float(row.get("uncertainty_t/h"))
            unc = unc_t * 1000 if unc_t is not None else None

            lat = safe_float(row.get("lat"))
            lon = safe_float(row.get("lon"))
            if lat is None or lon is None:
                continue

            # Composite ID: date+location | source CSV filename (for linking)
            lat_r = round(lat, 2)
            lon_r = round(lon, 2)
            lat_s = f"{abs(lat_r):.2f}{'N' if lat_r >= 0 else 'S'}"
            lon_s = f"{abs(lon_r):.2f}{'E' if lon_r >= 0 else 'W'}"
            date_compact = dt_raw.replace("-", "") if dt_raw else "nodate"
            display_id = f"sron_{date_compact}_{lat_s}_{lon_s}"
            plumes.append({
                "id": display_id,
                "link": row.get("source_file", ""),
                "src": "sron",
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "dt": dt,
                "rate": round(rate) if rate is not None else None,
                "unc": round(unc) if unc is not None else None,
                "sat": "TROPOMI",
            })
    print(f"  SRON: {len(plumes)} plumes")
    return plumes


# ghgsat: leaked, local-only. the whole data/ dir is gitignored and CI never
# fetches this source, so it can only ever enter a locally-built plumes.parquet —
# never the published Release. rate/unc in kg/hr; error is a relative fraction.
def build_ghgsat(path):
    if not path.exists():
        return []
    plumes = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if row.get("gas_type", "").upper() != "CH4":
                continue
            rate = safe_float(row.get("emission_rate"))
            lat = safe_float(row.get("latitude"))
            lon = safe_float(row.get("longitude"))
            if lat is None or lon is None:
                continue
            err = safe_float(row.get("emission_error_rate"))
            plumes.append({
                "id": row.get("id", ""),
                "src": "ghgsat",
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "dt": (row.get("date") or "")[:10] or None,
                "rate": round(rate) if rate is not None else None,
                "unc": round(rate * err) if rate is not None and err is not None else None,
                "sat": row.get("sensor", "GHGSat"),
            })
    print(f"  GHGSat: {len(plumes)} plumes (local-only)")
    return plumes


# datadesk: our own canonical s2-flares detections (`make dd` stages the
# disposable archive view). private-deploy-only like ghgsat: CI never stages
# the file and upload_plumes.sh refuses to publish dd rows.
def build_dd(path):
    if not path.exists():
        return []
    plumes = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            rate = safe_float(row.get("rate"))
            unc = safe_float(row.get("unc"))
            plumes.append({
                "id": row.get("id", ""),
                "link": row.get("link", ""),
                "src": "dd",
                "lat": round(float(row["lat"]), 4),
                "lon": round(float(row["lon"]), 4),
                "dt": (row.get("dt") or "")[:10] or None,
                "rate": round(rate) if rate is not None else None,
                "unc": round(unc) if unc is not None else None,
                "sat": row.get("sat"),
                "sec": "og",  # both detectors target oil & gas infrastructure
            })
    print(f"  Data Desk: {len(plumes)} plumes (local-only)")
    return plumes


# zstd parquet, dictionary-encoded strings. `link` is sron's source csv
# filename (the old FDP1 "display|file" composite id, split out); rate/unc in
# kg/hr; dt as iso string.
SCHEMA = pa.schema([
    ("id", pa.string()), ("link", pa.string()), ("src", pa.string()),
    ("lat", pa.float64()), ("lon", pa.float64()), ("dt", pa.string()),
    ("rate", pa.uint32()), ("unc", pa.uint32()),
    ("sat", pa.string()), ("sec", pa.string()),
])


def write_parquet(plumes, path):
    cols = {name: [p.get(name) for p in plumes] for name in SCHEMA.names}
    pq.write_table(pa.table(cols, schema=SCHEMA), path, compression="zstd")


def main():
    out_dir = Path("web/data")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Building plumes.parquet...")
    cm = build_cm(Path("data/carbon_mapper.csv"))
    imeo = build_imeo_plumes(Path("data/imeo_plumes.csv"))
    sron = build_sron(Path("data/sron_all.csv"))
    ghgsat = build_ghgsat(Path("data/ghgsat.csv"))
    datadesk = build_dd(Path("data/dd.csv"))

    all_plumes = cm + imeo + sron + ghgsat + datadesk

    plumes_path = out_dir / "plumes.parquet"
    write_parquet(all_plumes, plumes_path)
    size_mb = plumes_path.stat().st_size / (1024 * 1024)
    print(f"  → {plumes_path} ({len(all_plumes)} plumes, {size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
