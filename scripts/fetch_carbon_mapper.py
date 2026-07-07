import time

import httpx
from pathlib import Path

BASE_URL = "https://api.carbonmapper.org/api/v1/catalog/plume-csv"
PAGE_SIZE = 50000


# the full csv is a ~44 MB chunked response streamed over minutes; transient
# mid-body disconnects happen, so retry with backoff. the response is fully
# buffered inside client.get, so a retry never duplicates written rows.
def get(client, url, tries=4):
    for i in range(tries):
        try:
            resp = client.get(url)
            resp.raise_for_status()
            return resp
        except httpx.HTTPError as e:
            if i == tries - 1:
                raise
            print(f"  retrying after {e!r}")
            time.sleep(5 * 2**i)


def main():
    out = Path("data/carbon_mapper.csv")
    out.parent.mkdir(parents=True, exist_ok=True)

    client = httpx.Client(timeout=180, follow_redirects=True)
    header = None
    total = 0
    offset = 0

    with open(out, "w") as f:
        while True:
            url = f"{BASE_URL}?gas=CH4&limit={PAGE_SIZE}&offset={offset}"
            print(f"  Fetching offset={offset}...")
            resp = get(client, url)

            lines = resp.text.strip().split("\n")
            if len(lines) <= 1:
                break

            if header is None:
                header = lines[0]
                f.write(header + "\n")

            data_lines = lines[1:]
            for line in data_lines:
                if line.strip():
                    f.write(line + "\n")
                    total += 1

            offset += len(data_lines)
            if len(data_lines) < PAGE_SIZE:
                break

    client.close()
    print(f"Carbon Mapper: {total} plumes → {out}")


if __name__ == "__main__":
    main()
