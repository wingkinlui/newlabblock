"""Repair the tail of site/assets/js/viewer.js.

An earlier edit left the class body closed too early, with an orphaned
``resetView()`` after it.  This script moves ``resetView`` back inside the
class and removes the stray braces, then verifies the file parses.
"""

import re
import sys
from pathlib import Path

TARGET = Path(__file__).resolve().parent.parent / "site" / "assets" / "js" / "viewer.js"

RESET_VIEW = """  resetView() {
    if (!this.collision) return;
    const spawn = this.collision.spawn;
    this.position.set(spawn[0], spawn[1], spawn[2]);
    this.yaw = THREE.MathUtils.degToRad(this.collision.heading);
    this.pitch = 0;
    this.updateCamera();
  }
"""


def main():
    text = TARGET.read_text(encoding="utf-8")
    print(f"before: {len(text.splitlines())} lines")

    # Pull the orphaned resetView() out of the file.
    match = re.search(r"\n\s*resetView\(\) \{.*?\n  \}\s*$", text, re.S)
    if not match:
        print("no orphaned resetView found - nothing to do", file=sys.stderr)
        return 1

    text = text[:match.start()]

    # Remove the now duplicated closing braces of the class.
    text = re.sub(r"\n(\s*)\}\s*\n\s*\}\s*$", "\n}", text)

    # Insert resetView() just before the final class-closing brace.
    idx = text.rstrip().rfind("}")
    text = text[:idx] + "\n" + RESET_VIEW + text[idx:]

    TARGET.write_text(text, encoding="utf-8")
    print(f"after:  {len(text.splitlines())} lines")

    # Quick structural check.
    depth = 0
    for i, line in enumerate(text.splitlines(), start=1):
        depth += line.count("{") - line.count("}")
        if depth < 0:
            print(f"ERROR: unbalanced braces at line {i}")
            return 1
    print(f"final brace depth: {depth}")
    if depth != 0:
        print("ERROR: file is not balanced", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
