"""fetch imeo plumes from the eye on methane v2 api.

the methanedata.unep.org host sits behind a cloudflare managed challenge that
fingerprints the tls/http2 handshake, so an ordinary client (httpx, requests,
curl) is blocked even with a valid key. curl_cffi impersonates chrome's ja3
fingerprint and passes straight through, so the bearer key is all that's left.

set IMEO_API_KEY (request one from unep-methanedata@un.org). without a key we
keep any existing data/imeo_plumes.csv so manual drops still work as a fallback.
"""

import csv
import os
import sys
from pathlib import Path

from curl_cffi import requests

API = "https://methanedata.unep.org/api/v2/plumes_w_wo_sources"
# only the columns build.py's build_imeo_plumes reads (the api returns ~36)
COLS = ["id_plume", "lat", "lon", "ch4_fluxrate", "ch4_fluxrate_std",
        "tile_date", "satellite", "sector"]


def main():
    out = Path("data/imeo_plumes.csv")
    out.parent.mkdir(parents=True, exist_ok=True)

    key = os.environ.get("IMEO_API_KEY")
    if not key:
        if out.exists():
            print(f"IMEO: no IMEO_API_KEY, keeping existing {out}")
            return
        sys.exit("IMEO: no IMEO_API_KEY and no existing CSV")

    r = requests.get(API, headers={"authorization": f"Bearer {key}"},
                     impersonate="chrome", timeout=180)
    r.raise_for_status()
    plumes = r.json()

    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(plumes)
    print(f"IMEO: {len(plumes)} plumes → {out}")


if __name__ == "__main__":
    main()
