"""Insert the password gate into every HTML page of the site.

The patch is idempotent: running it twice does not change the files again.
For each page it

  * adds ``assets/css/auth.css`` to the <head>,
  * imports the auth helpers at the top of the module script,
  * awaits ``requireAuth()`` before any asset is fetched,
  * adds the "Lock" button to the header navigation.
"""

import re
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"

PAGES = ["index.html", "3d.html", "floorplan.html", "snapshots.html"]

AUTH_CSS = '<link rel="stylesheet" href="assets/css/auth.css">'
AUTH_IMPORT = ("import { requireAuth, initLockButton } from './assets/js/auth.js';")


def patch(text: str) -> str:
    # 1. stylesheet
    if AUTH_CSS not in text:
        text = text.replace(
            '<link rel="stylesheet" href="assets/css/style.css">',
            f'<link rel="stylesheet" href="assets/css/style.css">\n{AUTH_CSS}',
        )

    # 2. import + await gate before the rest of the module script
    if AUTH_IMPORT not in text:
        text = text.replace(
            "<script type=\"module\">\n",
            f"<script type=\"module\">\n{AUTH_IMPORT}\nawait requireAuth();\n",
            1,
        )

    # 3. lock button
    if "initLockButton();" not in text:
        marker = "await requireAuth();\n"
        idx = text.find(marker)
        if idx != -1:
            text = (text[:idx + len(marker)]
                    + "initLockButton();\n"
                    + text[idx + len(marker):])

    return text


def main():
    for name in PAGES:
        path = SITE / name
        if not path.exists():
            print(f"skip (missing): {name}")
            continue
        original = path.read_text(encoding="utf-8")
        updated = patch(original)
        if updated == original:
            print(f"unchanged: {name}")
        else:
            path.write_text(updated, encoding="utf-8")
            print(f"patched:   {name}")


if __name__ == "__main__":
    main()
