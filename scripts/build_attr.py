#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow"]
# ///
# web/data/attributions.parquet → web/data/attributions.bin (FDA2).
#
# format (little-endian):
#   'FDA2' | u32 count | u8 n_models | n × (u8 len + utf8)
#   per record:
#     u8  kind<<4 | confidence   (kind: well facility pipeline mine landfill
#                                 other none; conf: high medium low; 15 absent)
#     u16 run_at, days since 2020-01-01
#     u8  model index
#     u8  coords<<2 | verified   (verified: confirmed refuted unclear; 3 absent)
#     f32 lat, f32 lon           assessed source point, when coords bit set
#     8 × varint-len utf8: plume id, source_label, source_name, operator,
#                          attributed ids \x1f-joined, paragraph,
#                          evidence urls \x1f-joined, verify_notes
import struct
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
KIND = "well facility pipeline mine landfill other none".split()
CONF = "high medium low".split()
VERIFIED = "confirmed refuted unclear".split()


def vs(s):
    b = (s or "").encode()
    out, n = bytearray(), len(b)
    while n > 0x7F:
        out.append(n & 0x7F | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out) + b


def build():
    rows = pq.read_table(ROOT / "web/data/attributions.parquet").to_pylist()
    models = sorted({r.get("model") or "" for r in rows})
    out = bytearray(b"FDA2") + struct.pack("<I", len(rows)) + bytes([len(models)])
    for m in models:
        out += bytes([len(m.encode())]) + m.encode()
    for r in sorted(rows, key=lambda r: r["id"]):
        kind = KIND.index(r["source_kind"]) if r.get("source_kind") in KIND else 5
        conf = CONF.index(r["confidence"]) if r.get("confidence") in CONF else 15
        try:
            days = (date.fromisoformat(str(r["run_at"])) - date(2020, 1, 1)).days
        except (KeyError, TypeError, ValueError):
            days = 0
        ver = VERIFIED.index(r["verified"]) if r.get("verified") in VERIFIED else 3
        coords = r.get("lat") is not None and r.get("lon") is not None
        out += bytes([kind << 4 | conf]) + struct.pack("<H", days)
        out += bytes([models.index(r.get("model") or ""), coords << 2 | ver])
        if coords:
            out += struct.pack("<2f", r["lat"], r["lon"])
        for s in (r["id"], r.get("source_label"), r.get("source_name"), r.get("operator"),
                  "\x1f".join(r.get("attributed_ids") or []), r.get("paragraph"), "\x1f".join(r.get("evidence") or []),
                  r.get("verify_notes")):
            out += vs(s)
    (ROOT / "web/data/attributions.bin").write_bytes(out)
    print(f"attributions.bin: {len(rows)} records, {len(out):,} bytes")


if __name__ == "__main__":
    build()
