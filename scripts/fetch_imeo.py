"""Fetch IMEO plume data from methanedata.unep.org.

The download URL is behind Cloudflare, so automated fetching may fail.
When it does, download manually in a browser and place the CSV at data/imeo_plumes.csv:

  1. Visit https://methanedata.unep.org/downloads
  2. Download "Detected plumes" CSV
  3. Unzip → move CSV to data/imeo_plumes.csv
"""

import io
import sys
import zipfile
from pathlib import Path

import httpx

URL = "https://methanedata.unep.org/downloads/unep_methanedata_detected_plumes_csv.zip"


def main():
    out = Path("data/imeo_plumes.csv")
    out.parent.mkdir(parents=True, exist_ok=True)

    if out.exists():
        lines = out.read_text().count("\n")
        print(f"IMEO: using existing {out} ({lines - 1} rows)")
        return

    print("Downloading IMEO plume data...")
    try:
        resp = httpx.get(URL, timeout=120, follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        print(f"  IMEO download failed ({e.response.status_code}) — Cloudflare blocked.")
        print(f"  Download manually: {URL}")
        sys.exit(1)

    content_type = resp.headers.get("content-type", "")
    if "text/html" in content_type:
        print("  IMEO download returned HTML (Cloudflare challenge).")
        print(f"  Download manually: {URL}")
        sys.exit(1)

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        csvs = [n for n in zf.namelist() if n.endswith(".csv")]
        if not csvs:
            raise RuntimeError(f"No CSV found in ZIP: {zf.namelist()}")
        name = csvs[0]
        data = zf.read(name)
        out.write_bytes(data)
        lines = data.count(b"\n")
        print(f"  IMEO: {lines - 1} rows → {out}")


if __name__ == "__main__":
    main()
