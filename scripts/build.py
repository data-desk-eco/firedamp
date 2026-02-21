import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

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
    if raw in ("Other", "Unclassified"):
        return "other"
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
            dt_raw = row.get("datetime", "")
            try:
                dt = dt_raw[:10]  # "YYYY-MM-DD..."
            except Exception:
                dt = None

            rate = safe_float(row.get("emission_auto"))
            if rate is None:
                continue

            plumes.append({
                "id": row.get("plume_id", ""),
                "src": "cm",
                "lat": safe_float(row.get("plume_latitude")),
                "lon": safe_float(row.get("plume_longitude")),
                "dt": dt,
                "rate": rate,
                "unc": safe_float(row.get("emission_uncertainty_auto")),
                "sat": row.get("platform", "Tanager-1"),
                "sec": map_sector(row.get("ipcc_sector")),
                "cty": row.get("country_code") or None,
            })
    print(f"  CM: {len(plumes)} plumes")
    return plumes


def build_imeo_plumes(path):
    with open(path) as f:
        data = json.load(f)

    plumes = []
    for feat in data["features"]:
        p = feat["properties"]

        rate = safe_float(p.get("ch4_fluxrate"))
        if rate is None:
            continue

        dt_raw = p.get("tile_date", "")
        dt = dt_raw[:10] if dt_raw else None

        sat_raw = p.get("satellite", "")
        sat = SAT_SHORT.get(sat_raw, sat_raw)

        # country is full name in IMEO plumes, not alpha-2 — leave as-is
        # (would need a full name→alpha2 mapping; skip for now)
        cty = None

        plumes.append({
            "id": p.get("id_plume", ""),
            "src": "imeo",
            "lat": safe_float(p.get("lat")),
            "lon": safe_float(p.get("lon")),
            "dt": dt,
            "rate": rate,
            "unc": safe_float(p.get("ch4_fluxrate_std")),
            "sat": sat,
            "sec": map_sector(p.get("sector")),
            "cty": cty,
        })
    print(f"  IMEO: {len(plumes)} plumes")
    return plumes


def build_imeo_sources(path):
    with open(path) as f:
        data = json.load(f)

    sources = []
    for feat in data["features"]:
        p = feat["properties"]
        name = p.get("source_name", "")

        # Extract country alpha-2 from source_name prefix (e.g. "ARG_S_002" → "AR")
        prefix = name.split("_")[0] if "_" in name else ""
        cty = ISO3_TO_2.get(prefix)

        last_raw = p.get("last_plume_date", "")
        last_dt = last_raw[:10] if last_raw else None

        coords = feat["geometry"]["coordinates"]
        lat = safe_float(p.get("lat")) or safe_float(coords[1])
        lon = safe_float(p.get("lon")) or safe_float(coords[0])

        sources.append({
            "id": name,
            "lat": lat,
            "lon": lon,
            "cty": cty,
            "sec": map_sector(p.get("sector")),
            "n": p.get("n_plumes_detected", 0),
            "persist": p.get("persistency_category", ""),
            "last": last_dt,
        })
    print(f"  IMEO sources: {len(sources)}")
    return sources


def build_sron(path):
    plumes = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            dt_raw = row.get("date", "")
            # YYYYMMDD → YYYY-MM-DD
            if len(dt_raw) == 8 and dt_raw.isdigit():
                dt = f"{dt_raw[:4]}-{dt_raw[4:6]}-{dt_raw[6:8]}"
            else:
                dt = dt_raw[:10] if dt_raw else None

            rate_t = safe_float(row.get("source_rate_t/h"))
            if rate_t is None:
                continue
            rate = rate_t * 1000  # tonnes/hr → kg/hr

            unc_t = safe_float(row.get("uncertainty_t/h"))
            unc = unc_t * 1000 if unc_t is not None else None

            lat = safe_float(row.get("lat"))
            lon = safe_float(row.get("lon"))

            # Generate stable ID from date+lat+lon
            key = f"{dt_raw}:{lat}:{lon}"
            hid = hashlib.md5(key.encode()).hexdigest()[:12]

            plumes.append({
                "id": f"sron_{hid}",
                "src": "sron",
                "lat": lat,
                "lon": lon,
                "dt": dt,
                "rate": round(rate, 1),
                "unc": round(unc, 1) if unc is not None else None,
                "sat": "TROPOMI",
                "sec": None,
                "cty": None,
            })
    print(f"  SRON: {len(plumes)} plumes")
    return plumes


def main():
    out_dir = Path("web/data")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Building plumes.json...")
    cm = build_cm(Path("data/carbon_mapper.csv"))
    imeo = build_imeo_plumes(Path("plumes_data/unep_methanedata_detected_plumes.geojson"))
    sron = build_sron(Path("data/sron_all.csv"))

    all_plumes = cm + imeo + sron

    plumes_out = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "counts": {"cm": len(cm), "imeo": len(imeo), "sron": len(sron)},
        },
        "plumes": all_plumes,
    }

    plumes_path = out_dir / "plumes.json"
    with open(plumes_path, "w") as f:
        json.dump(plumes_out, f, separators=(",", ":"))
    print(f"  → {plumes_path} ({len(all_plumes)} total plumes)")

    print("Building sources.json...")
    sources = build_imeo_sources(Path("plumes_data/unep_methanedata_detected_sources.geojson"))
    sources_path = out_dir / "sources.json"
    with open(sources_path, "w") as f:
        json.dump(sources, f, separators=(",", ":"))
    print(f"  → {sources_path} ({len(sources)} sources)")


if __name__ == "__main__":
    main()
