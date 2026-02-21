import re
from pathlib import Path

import httpx


INDEX_URL = "https://ftp.sron.nl/pub/memo/CSVs/"
PATTERN = re.compile(r'href="(SRON_Weekly_Methane_Plumes_[^"]+\.csv)"')


def main():
    out_dir = Path("data/sron")
    out_dir.mkdir(parents=True, exist_ok=True)

    # Browse directory listing for CSV links
    resp = httpx.get(INDEX_URL, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    filenames = PATTERN.findall(resp.text)
    print(f"Found {len(filenames)} SRON CSVs")

    # Download each CSV (skip existing)
    for fn in filenames:
        dest = out_dir / fn
        if dest.exists():
            continue
        url = INDEX_URL + fn
        r = httpx.get(url, timeout=60, follow_redirects=True)
        r.raise_for_status()
        dest.write_bytes(r.content)
        print(f"  Downloaded {fn}")

    # Concatenate into single CSV (normalize headers — some files lack index col)
    all_out = Path("data/sron_all.csv")
    canonical = "date,time_UTC,lat,lon,source_rate_t/h,uncertainty_t/h"
    total = 0
    with open(all_out, "w") as out:
        out.write(canonical + "\n")
        for csv_path in sorted(out_dir.glob("SRON_Weekly_Methane_Plumes_*.csv")):
            lines = csv_path.read_text().strip().split("\n")
            if not lines:
                continue
            header = lines[0].strip()
            # Detect whether file has an extra leading index column
            has_index = header.startswith(",date,") or header.startswith(",date\t")
            for line in lines[1:]:
                line = line.strip()
                if not line:
                    continue
                if has_index:
                    # Strip the leading index value (e.g. "0," or "123,")
                    line = line.split(",", 1)[1]
                out.write(line + "\n")
                total += 1

    print(f"SRON total: {total} plumes → {all_out}")


if __name__ == "__main__":
    main()
