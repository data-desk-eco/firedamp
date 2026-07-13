"""fetch imeo plumes from the eye on methane public dataset.

unep publishes the full detected-plumes catalogue as a public azure blob zip
(linked from methanedata.unep.org/download-dataset) — no key, no cloudflare
challenge, refreshed roughly monthly. this is the reliable path: the old
`/api/v2` host is cloudflare-fingerprint-gated *and* the personal bearer key it
needed gets silently disabled. we just pull the zip and keep the columns
build.py reads. on any network failure we keep the existing csv as a fallback.
"""

import csv
import io
import sys
import zipfile
from pathlib import Path

import httpx

ZIP = "https://unepazeconomyadlsstorage.blob.core.windows.net/public/unep_methanedata_detected_plumes_csv.zip"
MEMBER = "unep_methanedata_detected_plumes.csv"
# only the columns build.py's build_imeo_plumes reads (the csv has ~23)
COLS = ["id_plume", "lat", "lon", "ch4_fluxrate", "ch4_fluxrate_std",
        "tile_date", "satellite", "sector"]


def main():
    out = Path("data/imeo_plumes.csv")
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        r = httpx.get(ZIP, follow_redirects=True, timeout=180)
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            rows = list(csv.DictReader(io.TextIOWrapper(z.open(MEMBER), "utf-8")))
    except Exception as e:
        if out.exists():
            print(f"IMEO: fetch failed ({e!r}), keeping existing {out}")
            return
        sys.exit(f"IMEO: fetch failed and no existing CSV: {e!r}")

    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"IMEO: {len(rows)} plumes → {out}")


if __name__ == "__main__":
    main()
