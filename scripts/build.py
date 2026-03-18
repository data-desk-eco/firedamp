import csv
import hashlib
import struct
from datetime import date, datetime, timezone
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

EPOCH = date(2020, 1, 1)
SRC_MAP = {"cm": 0, "imeo": 1, "sron": 2}
SEC_MAP = {None: 0, "og": 1, "coal": 2, "waste": 3, "other": 4}


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


def date_to_days(dt_str):
    if not dt_str:
        return 0
    try:
        return max(0, (date.fromisoformat(dt_str) - EPOCH).days)
    except ValueError:
        return 0


def build_cm(path):
    plumes = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("gas", "").upper() != "CH4":
                continue

            dt_raw = row.get("datetime", "")
            try:
                dt = dt_raw[:10]
            except Exception:
                dt = None

            rate = safe_float(row.get("emission_auto"))
            if rate is None:
                continue

            unc = safe_float(row.get("emission_uncertainty_auto"))
            plumes.append({
                "id": row.get("plume_id", ""),
                "src": "cm",
                "lat": round(safe_float(row.get("plume_latitude")), 4),
                "lon": round(safe_float(row.get("plume_longitude")), 4),
                "dt": dt,
                "rate": round(rate),
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
            if rate is None:
                continue

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
                "rate": round(rate),
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
            if rate_t is None:
                continue
            rate = rate_t * 1000

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
            source_file = row.get("source_file", "")
            plumes.append({
                "id": f"{display_id}|{source_file}",
                "src": "sron",
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "dt": dt,
                "rate": round(rate),
                "unc": round(unc) if unc is not None else None,
                "sat": "TROPOMI",
            })
    print(f"  SRON: {len(plumes)} plumes")
    return plumes


def write_binary(plumes, path):
    sats = sorted({p.get("sat") or "" for p in plumes})
    sat_idx = {s: i for i, s in enumerate(sats)}

    with open(path, "wb") as f:
        # Header
        f.write(b"FDP1")
        f.write(struct.pack("<I", len(plumes)))
        f.write(struct.pack("B", len(sats)))
        for s in sats:
            b = s.encode("utf-8")
            f.write(struct.pack("B", len(b)))
            f.write(b)

        # Records (20 bytes each)
        for p in plumes:
            lat = p.get("lat") or 0.0
            lon = p.get("lon") or 0.0
            days = date_to_days(p.get("dt"))
            rate = int(p.get("rate") or 0)
            unc = int(p.get("unc") or 0)
            src_val = SRC_MAP.get(p.get("src"), 0)
            sec_val = SEC_MAP.get(p.get("sec"), 0)
            src_sec = src_val | (sec_val << 2)
            si = sat_idx.get(p.get("sat") or "", 0)
            f.write(struct.pack("<ffHIIBB", lat, lon, days, rate, unc, src_sec, si))

        # IDs block
        ids = "\n".join(p.get("id", "") for p in plumes)
        f.write(ids.encode("utf-8"))


def main():
    out_dir = Path("web/data")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Building plumes.bin...")
    cm = build_cm(Path("data/carbon_mapper.csv"))
    imeo = build_imeo_plumes(Path("data/imeo_plumes.csv"))
    sron = build_sron(Path("data/sron_all.csv"))

    all_plumes = cm + imeo + sron

    plumes_path = out_dir / "plumes.bin"
    write_binary(all_plumes, plumes_path)
    size_mb = plumes_path.stat().st_size / (1024 * 1024)
    print(f"  → {plumes_path} ({len(all_plumes)} plumes, {size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
