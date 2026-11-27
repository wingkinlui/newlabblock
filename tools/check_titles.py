"""Check that the photo titles in the manifest match the TITLES mapping.

The titles live in two places: the mapping in tools/build_assets.py (the
source of truth for the next build) and site/assets/manifest.json (what the
site actually shows).  They have to agree, otherwise a rebuild would
silently rename the photos again.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "site" / "assets" / "manifest.json"
SOURCE = ROOT / "tools" / "build_assets.py"


def main():
    source = SOURCE.read_text(encoding="utf-8")
    block = re.search(r"TITLES = \{(.*?)\}", source, re.S)
    if not block:
        print("could not find the TITLES mapping", file=sys.stderr)
        return 1
    mapping = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', block.group(1)))

    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    print("snapshot titles:")
    problems = 0
    for item in data["snapshots"]:
        expected = mapping.get(item["id"])
        mark = ""
        if expected != item["title"]:
            mark = f"   <-- MISMATCH (build_assets.py says {expected!r})"
            problems += 1
        print(f"  {item['id']:22s} {item['title']}{mark}")

    if problems:
        print(f"\n{problems} mismatch(es)", file=sys.stderr)
        return 1
    print("\nall titles agree with tools/build_assets.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
