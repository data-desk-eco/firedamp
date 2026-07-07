#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb", "httpx", "pandas"]
# ///
# agentic plume attribution: assemble per-plume evidence from local data
# (ogim, osm, coal, plume archive) + wind/place, run a pi/deepseek agent with
# web research tools, collect result.json into web/data/attributions.json.
#
#   agent/run.py --init-db          build data/context.duckdb (one-time, ~min)
#   agent/run.py <plume-id>...      attribute specific plumes
#   agent/run.py --top N [--src s]  N largest unattributed plumes
#   agent/run.py -j 4 ...           parallel agents

import argparse, json, math, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb, httpx

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data/context.duckdb"
OUT = ROOT / "web/data/attributions.json"
RUNS = ROOT / "agent/runs"
CACHE = ROOT / "data/cache"
MODEL = "deepseek-v4-pro"

sys.path.insert(0, str(ROOT / "scripts"))

# ── db build ──

OGIM_LAYERS = ["Crude_Oil_Refineries", "Equipment_and_Components", "Gathering_and_Processing",
               "Injection_and_Disposal", "LNG_Facilities", "Natural_Gas_Compressor_Stations",
               "Offshore_Platforms", "Oil_and_Natural_Gas_Wells", "Petroleum_Terminals",
               "Stations_Other", "Tank_Battery"]
OGIM_COLS = ("OGIM_ID CATEGORY FAC_NAME FAC_TYPE FAC_STATUS OPERATOR COMMODITY COUNTRY "
             "STATE_PROV GAS_CAPACITY_MMCFD GAS_THROUGHPUT_MMCFD LIQ_CAPACITY_BPD "
             "NUM_COMPR_UNITS NUM_STORAGE_TANKS SPUD_DATE LATITUDE LONGITUDE").split()


def init_db():
    con = duckdb.connect(str(DB))
    con.sql("install spatial; load spatial")
    print("osm…")
    con.sql(f"""create or replace table osm as
        select regexp_extract(filename, '([a-z_]+)\\.csv', 1) tag, v, name, name_en, operator,
               product, resource, id, st_x(g) lon, st_y(g) lat
        from (select *, st_geomfromtext(centroid) g
              from read_csv('{ROOT}/data/osm/*.csv', filename=true))
        order by lat""")
    print("ogim…")
    parts = []
    for l in OGIM_LAYERS:
        have = {r[0] for r in con.sql(f"describe (from st_read('{ROOT}/data/OGIM_v2.7.gpkg', layer='{l}') limit 0)").fetchall()}
        sel = ", ".join(c if c in have else f"null as {c}" for c in OGIM_COLS)
        parts.append(f"select {sel} from st_read('{ROOT}/data/OGIM_v2.7.gpkg', layer='{l}')")
    con.sql("create or replace table ogim as " + " union all by name ".join(parts) + " order by LATITUDE")
    con.sql(f"""create or replace table ogim_fields as
        select NAME as "name", OPERATOR as "operator", geom
        from st_read('{ROOT}/data/OGIM_v2.7.gpkg', layer='Oil_and_Natural_Gas_Fields')""")
    build_extras(con)
    print("coal…")
    con.sql(f"create or replace table coal as from read_csv('{ROOT}/data/gcmt_coal.csv')")
    print("plumes…")
    import build
    rows = (build.build_cm(ROOT / "data/carbon_mapper.csv") + build.build_imeo_plumes(ROOT / "data/imeo_plumes.csv")
            + build.build_sron(ROOT / "data/sron_all.csv") + build.build_ghgsat(ROOT / "data/ghgsat.csv"))
    import pandas
    df = pandas.DataFrame(rows)
    con.sql("create or replace table plumes as from df order by lat")
    for t in ["osm", "ogim", "coal", "plumes"]:
        print(f"  {t}: {con.sql(f'select count(*) from {t}').fetchone()[0]:,} rows")


# provider-side extras the binary format drops: cm's plume-mask bounds, exact
# timestamps, cm's own model wind at detection time, ghgsat site. python csv
# because ghgsat's assets column defeats duckdb's sniffer
def build_extras(con):
    import csv
    rows = []
    with open(ROOT / "data/carbon_mapper.csv", newline="") as f:
        rows += [{"id": r["plume_id"], "ts": r["datetime"], "ipcc_sector": r["ipcc_sector"],
                  "plume_bounds": r["plume_bounds"], "instrument": r["instrument"],
                  "wind_ms": r["wind_speed_avg_auto"], "wind_from_deg": r["wind_direction_avg_auto"],
                  "wind_src": r["wind_source_auto"]} for r in csv.DictReader(f)]
    with open(ROOT / "data/ghgsat.csv", newline="") as f:
        rows += [{"id": r["id"], "ts": r["date"], "site": r["site"]} for r in csv.DictReader(f)]
    import pandas
    df = pandas.DataFrame(rows)
    con.sql("create or replace table extras as from df")


# ── per-plume context ──

# search radius (km) by source/sensor, mirroring the SENSORS table in
# web/analysis.js but wider: the agent reads text, not a map frame
def radius(p):
    sat = (p["sat"] or "").upper()
    if "TROPOMI" in sat:
        return 15
    if p["src"] == "cm":
        return 1.5 if any(s in sat for s in ("AVIRIS", "GAO", "AV3", "ANG")) else 2 if any(s in sat for s in ("TANAGER", "ENMAP")) else 3
    return {"ghgsat": 2, "imeo": 5}.get(p["src"], 3)


SENSOR_NOTE = {
    "cm": "carbon mapper hyperspectral: reported coordinate is usually within a few hundred metres of the source (tens of metres for aircraft). source_record.plume_bounds is the [w,s,e,n] bounding box of the imaged plume mask — the mask stretches downwind from the source, so the source sits at the upwind end.",
    "ghgsat": "ghgsat: nominal ~50 m accuracy but repeat detections scatter up to ~150 m.",
    "imeo": "un imeo/mars analyst-vetted detection, mixed sensors: source usually within ~1 km — unless the satellite is tropomi, in which case treat as a km-scale search area with the source usually upwind.",
    "sron": "sron tropomi: 5.5×7 km pixels; the source is typically 2-10 km away, almost always UPWIND of the reported coordinate. treat this as a search area, not a location.",
}


def bearing(lat1, lon1, lat2, lon2):
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass(deg):
    return "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split()[round(deg / 22.5) % 16]


def near(con, table, lat, lon, km, where="true", limit=60, latcol="lat", loncol="lon"):
    dlat, dlon = km / 111, km / (111 * max(0.1, math.cos(math.radians(lat))))
    rows = con.sql(f"""select * from {table}
        where {latcol} between {lat - dlat} and {lat + dlat}
          and {loncol} between {lon - dlon} and {lon + dlon} and ({where})""").df().to_dict("records")
    out = []
    for r in rows:
        rlat, rlon = r.pop(latcol), r.pop(loncol)
        d = 6371 * math.acos(min(1, math.sin(math.radians(lat)) * math.sin(math.radians(rlat))
            + math.cos(math.radians(lat)) * math.cos(math.radians(rlat)) * math.cos(math.radians(lon - rlon))))
        if d > km:
            continue
        out.append({"dist_km": round(d, 2), "bearing": compass(bearing(lat, lon, rlat, rlon)),
                    "lat": round(rlat, 5), "lon": round(rlon, 5),
                    **{k: v for k, v in r.items() if v is not None and v == v and v != ""}})
    return sorted(out, key=lambda r: r["dist_km"])[:limit]


def cached_get(name, url):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / name
    if f.exists():
        return json.loads(f.read_text())
    try:
        r = httpx.get(url, headers={"User-Agent": "firedamp-attribution"}, timeout=30)
        r.raise_for_status()
        f.write_text(r.text)
        return r.json()
    except Exception as e:
        print(f"  warn: {url.split('?')[0]} failed: {e}", file=sys.stderr)
        return None


def vec_mean(pairs):
    su = sv = n = 0
    for s, deg in pairs:
        if s is None or deg is None:
            continue
        rad = math.radians((deg + 180) % 360)
        su += s * math.sin(rad); sv += s * math.cos(rad); n += 1
    if not n:
        return None
    u, v = su / n, sv / n
    to = (math.degrees(math.atan2(u, v)) + 360) % 360
    frm = (to + 180) % 360
    return {"speed_ms": round(math.hypot(u, v), 1), "from_deg": round(frm), "from": compass(frm),
            "blowing_toward": compass(to)}


# open-meteo archive: vector-mean daily wind, plus a ±1 h window around the
# detection hour when the source csv carries a full timestamp
def fetch_wind(lat, lon, dt, ts=None):
    if not dt:
        return None
    d = cached_get(f"wind_{lat:.3f}_{lon:.3f}_{dt}.json",
        f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}"
        f"&start_date={dt}&end_date={dt}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=GMT")
    h = (d or {}).get("hourly") or {}
    pairs = list(zip(h.get("wind_speed_10m") or [], h.get("wind_direction_10m") or []))
    wind = vec_mean(pairs)
    if not wind:
        return None
    out = {"daily_mean": wind}
    try:
        hr = int(str(ts)[11:13])
        at = vec_mean(pairs[max(0, hr - 1):hr + 2])
        if at:
            out["at_detection_utc"] = at | {"hour_utc": hr}
    except (ValueError, TypeError):
        pass
    return out


# wide-radius osm queries keep named features or high-signal types so
# unnamed barns don't drown the list (mirrors the overpass tiering)
OSM_SIGNAL = ("'landfill','quarry','mineshaft','adit','spoil_heap','tailings_pond','wastewater_plant',"
              "'digester','petroleum_well','pumping_station','flare','gasometer','waste_transfer_station',"
              "'waste_disposal','gas','oil','coal','biogas','lng'")


def assemble(con, p):
    lat, lon, km = p["lat"], p["lon"], radius(p)
    rate, unc = p.pop("rate"), p.pop("unc")
    ex = con.sql("select * from extras where id = ?", params=[p["id"]]).df().to_dict("records")
    rec = {k: v for k, v in (ex[0] if ex else {}).items()
           if k != "id" and v is not None and v == v and v != ""}
    osm_where = "true" if km <= 3 else f"name is not null or v in ({OSM_SIGNAL})"
    place = cached_get(f"place_{lat:.3f}_{lon:.3f}.json",
        f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json&zoom=10&accept-language=en") or {}
    hist_km = min(30, max(10, 2 * km))
    hist = [h for h in near(con, "plumes", lat, lon, hist_km, limit=200) if h.get("id") != p["id"]]
    field = con.sql(f"""select "name", operator from ogim_fields
        where st_contains(geom, st_point({lon}, {lat}))""").fetchall()
    return {
        "plume": {**p, "rate_kg_hr": rate, "uncertainty_kg_hr": unc,
                  "sensor_note": SENSOR_NOTE.get(p["src"], ""), "search_radius_km": km,
                  "source_record": rec or None},
        "place": place.get("display_name"),
        "wind": fetch_wind(lat, lon, p["dt"], rec.get("ts")),
        "og_field": [" · ".join(filter(None, f)) for f in field] or None,
        "detection_history": {
            "note": f"all satellite detections within {hist_km} km from the 4-source archive (this plume excluded; rate in kg/hr)",
            "count": len(hist),
            "detections": sorted(hist, key=lambda h: h["dist_km"])[:40],
        },
        "ogim": near(con, "ogim", lat, lon, km, latcol="LATITUDE", loncol="LONGITUDE"),
        "osm": near(con, "osm", lat, lon, km, where=osm_where, limit=80),
        "coal_mines": near(con, "coal", lat, lon, max(km, 20), limit=15, loncol="lng"),
    }


# ── agent runs ──

def run_one(con, p):
    con = con.cursor()  # duckdb connections are not thread-safe; cursors are per-thread
    pid = p["id"]
    d = RUNS / pid.replace("/", "_").replace("|", "_")
    d.mkdir(parents=True, exist_ok=True)
    ctx = assemble(con, dict(p))
    (d / "context.json").write_text(json.dumps(ctx, indent=1, default=str))
    if os.environ.get("DRY"):
        return pid, None
    env = os.environ | {"PATH": f"{ROOT}/agent/bin:{os.environ['PATH']}"}
    cmd = ["pi", "-p", "--mode", "json", "--no-session", "-ne", "-ns", "-np", "-nc",
           "--provider", "deepseek", "--model", MODEL,
           "--system-prompt", "you are a rigorous methane source-attribution researcher. follow the task exactly.",
           f"@{ROOT}/agent/task.md", "@context.json"]
    t = time.time()
    with open(d / "log.json", "w") as log:
        try:
            subprocess.run(cmd, cwd=d, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        except subprocess.TimeoutExpired:
            print(f"  {pid}: timeout", file=sys.stderr)
    try:
        res = json.loads((d / "result.json").read_text())
    except Exception as e:
        print(f"  {pid}: no result ({e})", file=sys.stderr)
        return pid, None
    aid = res.get("attributed_id")
    if aid and str(aid).split(":", 1)[-1] not in (d / "context.json").read_text():
        print(f"  {pid}: attributed_id {aid} not in context — nulled", file=sys.stderr)
        res["attributed_id"] = None
    print(f"  {pid}: {res.get('source_label')} [{res.get('confidence')}] {time.time() - t:.0f}s")
    return pid, res | {"model": MODEL, "run_at": time.strftime("%Y-%m-%d")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--init-db", action="store_true")
    ap.add_argument("--top", type=int, help="n largest unattributed plumes")
    ap.add_argument("--src", help="filter --top by source")
    ap.add_argument("-j", type=int, default=1)
    ap.add_argument("-f", "--force", action="store_true", help="re-run even if already attributed")
    a = ap.parse_args()
    if a.init_db:
        return init_db()
    con = duckdb.connect(str(DB), read_only=True)
    con.sql("load spatial")
    db = json.loads(OUT.read_text()) if OUT.exists() else {}
    if a.top:
        w = f"src = '{a.src}'" if a.src else "true"
        ids = [r[0] for r in con.sql(f"select id from plumes where {w} order by rate desc limit {a.top + len(db)}").fetchall()]
        ids = [i for i in ids if a.force or i not in db][:a.top]
    else:
        ids = [i for i in a.ids if a.force or i not in db]
    plumes = {r["id"]: r for r in con.sql("from plumes").df().to_dict("records") if r["id"] in set(ids)}
    missing = [i for i in ids if i not in plumes]
    if missing:
        print(f"unknown ids: {missing}", file=sys.stderr)
    print(f"attributing {len(plumes)} plumes (j={a.j})")
    with ThreadPoolExecutor(a.j) as ex:
        for pid, res in ex.map(lambda p: run_one(con, p), [plumes[i] for i in ids if i in plumes]):
            if res:
                db[pid] = res
                OUT.write_text(json.dumps(db, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
