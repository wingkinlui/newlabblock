"""Restore the plaintext assets so they can be re-encrypted.

The published assets in site/assets are AES-256-GCM ciphertext.  When the
build scripts are re-run they write *plaintext* files, and the encryption
step then has to run last.  This helper restores a known-good plaintext copy
from work/plaintext_assets/ so a rebuild always starts from a clean state.

Usage:
    python restore_plaintext.py
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR = ROOT / "work" / "plaintext_assets"
TARGET = ROOT / "site" / "assets"
DIRS = ["models", "img", "collision"]


def main():
    if not MIRROR.exists():
        print(f"no plaintext mirror at {MIRROR}", file=sys.stderr)
        print("Run tools/build_models.py and tools/build_assets.py first.",
              file=sys.stderr)
        return 1

    for name in DIRS:
        source = MIRROR / name
        target = TARGET / name
        if not source.exists():
            print(f"  skipping {name} (not in the mirror)")
            continue
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target)
        count = len(list(target.rglob("*")))
        print(f"  restored {name} ({count} entries)")

    print("\nThe assets are plaintext again - run tools/encrypt_assets.py next.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
