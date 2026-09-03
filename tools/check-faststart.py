#!/usr/bin/env python3
"""Report MP4 top-level atom order.

`moov` must appear before `mdat`, otherwise the browser has to download the
entire file before it can decode the first frame -- which is the single biggest
cause of the slow page load this tooling exists to fix.

Usage:  tools/check-faststart.py assets/videos/*.mp4
Exits non-zero if any file is not faststart, so it can gate a deploy.
"""
import struct
import sys


def atom_order(path, limit=8):
    order = []
    with open(path, "rb") as f:
        pos = 0
        for _ in range(limit):
            f.seek(pos)
            head = f.read(8)
            if len(head) < 8:
                break
            size, kind = struct.unpack(">I4s", head)
            order.append(kind.decode("ascii", "replace"))
            if size == 1:               # 64-bit extended size
                size = struct.unpack(">Q", f.read(8))[0]
            if size < 8:
                break
            pos += size
    return order


def main(paths):
    if not paths:
        print(__doc__)
        return 2
    bad = 0
    for path in paths:
        try:
            order = atom_order(path)
        except OSError as exc:
            print(f"ERROR  {path}: {exc}")
            bad += 1
            continue
        try:
            ok = order.index("moov") < order.index("mdat")
        except ValueError:
            ok = False
        bad += not ok
        print(f"{'ok  ' if ok else 'SLOW'}  {path}  [{' '.join(order)}]")
    if bad:
        print(f"\n{bad} file(s) not faststart -- re-encode with -movflags +faststart")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
