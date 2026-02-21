import json
from pathlib import Path


def main():
    plumes = Path("plumes_data/unep_methanedata_detected_plumes.geojson")
    sources = Path("plumes_data/unep_methanedata_detected_sources.geojson")

    assert plumes.exists(), f"Missing {plumes}"
    assert sources.exists(), f"Missing {sources}"

    with open(plumes) as f:
        data = json.load(f)
        print(f"IMEO plumes: {len(data['features'])} features")

    with open(sources) as f:
        data = json.load(f)
        print(f"IMEO sources: {len(data['features'])} features")


if __name__ == "__main__":
    main()
