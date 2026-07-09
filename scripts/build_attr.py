#!/usr/bin/env python3
# web/data/attributions.json → web/data/attributions.bin (FDA1).
# stdlib only: dist.sh runs this on the bare pages runner.
#
# format (little-endian):
#   'FDA1' | u32 count | u8 n_models | n × (u8 len + utf8)
#   per record:
#     u8  kind<<4 | confidence   (kind: well facility pipeline mine landfill
#                                 other none; conf: high medium low; 15 absent)
#     u16 run_at, days since 2020-01-01
#     u8  model index
#     7 × varint-len utf8: plume id, source_label, source_name, operator,
#                          attributed_id, paragraph, evidence urls \x1f-joined
import json, struct
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = "well facility pipeline mine landfill other none".split()
CONF = "high medium low".split()


def vs(s):
    b = (s or "").encode()
    out, n = bytearray(), len(b)
    while n > 0x7F:
        out.append(n & 0x7F | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out) + b


def build():
    db = json.loads((ROOT / "web/data/attributions.json").read_text())
    models = sorted({r.get("model") or "" for r in db.values()})
    out = bytearray(b"FDA1") + struct.pack("<I", len(db)) + bytes([len(models)])
    for m in models:
        out += bytes([len(m.encode())]) + m.encode()
    for pid, r in sorted(db.items()):
        kind = KIND.index(r["source_kind"]) if r.get("source_kind") in KIND else 5
        conf = CONF.index(r["confidence"]) if r.get("confidence") in CONF else 15
        try:
            days = (date.fromisoformat(r["run_at"]) - date(2020, 1, 1)).days
        except (KeyError, ValueError):
            days = 0
        out += bytes([kind << 4 | conf]) + struct.pack("<H", days) + bytes([models.index(r.get("model") or "")])
        for s in (pid, r.get("source_label"), r.get("source_name"), r.get("operator"),
                  r.get("attributed_id"), r.get("paragraph"), "\x1f".join(r.get("evidence") or [])):
            out += vs(s)
    (ROOT / "web/data/attributions.bin").write_bytes(out)
    print(f"attributions.bin: {len(db)} records, {len(out):,} bytes")


if __name__ == "__main__":
    build()
