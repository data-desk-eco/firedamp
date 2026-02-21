import httpx
from pathlib import Path

BASE_URL = "https://api.carbonmapper.org/api/v1/catalog/plume-csv"
PAGE_SIZE = 50000


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
            resp = client.get(url)
            resp.raise_for_status()

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
