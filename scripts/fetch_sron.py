import re
from pathlib import Path

import httpx


FTP_URL = "https://ftp.sron.nl/pub/memo/CSVs/"
WEBSITE_URL = "https://www.sron.nl/en/pillars/science/earth/methane/methane-plume-maps/"

FTP_PATTERN = re.compile(r'href="(SRON_Weekly_Methane_Plumes_[^"]+\.csv)"')
# Website hosts CSVs under wp-content/uploads with occasional -1 suffix
WEBSITE_PATTERN = re.compile(
    r'href="(https://www\.sron\.nl/wp-content/uploads/[^"]*'
    r'SRON_Weekly_Methane_Plumes_[^"]+\.csv)"'
)
# Normalise website filenames: strip trailing -1 before .csv
SUFFIX_RE = re.compile(r"-\d+(\.csv)$")


def canonical_name(fn: str) -> str:
    """Strip WordPress -1/-2 suffix from filename."""
    return SUFFIX_RE.sub(r"\1", fn)


def main():
    out_dir = Path("data/sron")
    out_dir.mkdir(parents=True, exist_ok=True)

    downloads: dict[str, str] = {}  # canonical filename → url

    # 1. FTP directory listing
    resp = httpx.get(FTP_URL, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    for fn in FTP_PATTERN.findall(resp.text):
        downloads[fn] = FTP_URL + fn
    print(f"FTP: {len(downloads)} CSVs")

    # 2. SRON website (has newer weeks before FTP catches up)
    try:
        resp = httpx.get(WEBSITE_URL, timeout=60, follow_redirects=True)
        resp.raise_for_status()
        website_urls = WEBSITE_PATTERN.findall(resp.text)
        added = 0
        for url in website_urls:
            raw_fn = url.rsplit("/", 1)[-1]
            fn = canonical_name(raw_fn)
            if fn not in downloads:
                downloads[fn] = url
                added += 1
        print(f"Website: {added} additional CSVs")
    except httpx.HTTPError as e:
        print(f"Website scrape failed (non-fatal): {e}")

    print(f"Total: {len(downloads)} CSVs")

    # Download each CSV (skip existing)
    for fn, url in sorted(downloads.items()):
        dest = out_dir / fn
        if dest.exists():
            continue
        r = httpx.get(url, timeout=60, follow_redirects=True)
        r.raise_for_status()
        dest.write_bytes(r.content)
        print(f"  Downloaded {fn}")

    # Concatenate into single CSV (normalize headers — some files lack index col)
    all_out = Path("data/sron_all.csv")
    canonical = "date,time_UTC,lat,lon,source_rate_t/h,uncertainty_t/h,source_file"
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
                out.write(f"{line},{csv_path.name}\n")
                total += 1

    print(f"SRON total: {total} plumes → {all_out}")


if __name__ == "__main__":
    main()
