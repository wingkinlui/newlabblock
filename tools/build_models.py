"""Build the three PolyCam captures into web-ready GLB files.

Pipeline per model:
  1. copy the source .glb into the work directory
  2. downscale the embedded 4096 px JPEG textures to 2048 px
  3. run gltf-pipeline with Draco compression on the geometry
  4. copy the result into site/assets/models/
  5. build the walkability/collision grid and write it next to the manifest

Run:  python build_models.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
SITE = ROOT / "site"
MODEL_DIR = SITE / "assets" / "models"
COLLISION_DIR = SITE / "assets" / "collision"
PYTHON = sys.executable

MODELS = [
    {"slug": "openlab", "title": "Open Lab",
     "subtitle": "Long open-plan laboratory - PolyCam capture, 27 Nov 2026",
     "source": ROOT / "3DSpace" / "OpenLab" / "27_11_2026.glb"},
    {"slug": "typeclab", "title": "Type C Lab",
     "subtitle": "Type C laboratory - PolyCam capture",
     "source": ROOT / "3DSpace" / "TypeCLab" / "TypeCLab.glb"},
    {"slug": "tfoffice", "title": "TF Office",
     "subtitle": "Supervisor's office - PolyCam capture",
     "source": ROOT / "3DSpace" / "TFOFFICE" / "TF OFFICE.glb"},
]

MAX_TEXTURE = 2048
TEXTURE_QUALITY = 82
DRACO_LEVEL = 10


def run(cmd, cwd=None):
    print("  $", " ".join(str(c) for c in cmd[:4]), "...")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout[-2000:])
        print(result.stderr[-2000:], file=sys.stderr)
        raise SystemExit(f"command failed: {cmd}")
    return result


def main():
    WORK.mkdir(exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    COLLISION_DIR.mkdir(parents=True, exist_ok=True)

    for entry in MODELS:
        slug = entry["slug"]
        src = entry["source"]
        print(f"\n=== {slug} ({entry['title']}) ===")

        opt = WORK / f"{slug}_opt.glb"
        run([PYTHON, str(ROOT / "tools" / "optimize_glb.py"), src, opt,
             "--max", str(MAX_TEXTURE), "--quality", str(TEXTURE_QUALITY)])

        final = MODEL_DIR / f"{slug}.glb"
        # Call the locally installed CLI directly (npx is not on PATH for
        # child processes on Windows).
        pipeline = ROOT / "site" / "node_modules" / ".bin" / (
            "gltf-pipeline.cmd" if sys.platform == "win32" else "gltf-pipeline")
        run([str(pipeline), "-i", str(opt), "-o", str(final),
             "--draco.compressionLevel", str(DRACO_LEVEL)], cwd=str(SITE))

        # Collision grid from the *source* geometry (uncompressed is fine and
        # avoids running a Draco decoder in Python).  Work on a copy so the
        # original source folder is never modified.
        src_copy = WORK / f"{slug}_src.glb"
        shutil.copy2(src, src_copy)
        run([PYTHON, str(ROOT / "tools" / "build_collision.py"), str(src_copy)],
            cwd=str(WORK))
        produced = src_copy.with_suffix(".collision.json")
        coll = WORK / f"{slug}.collision.json"
        if produced.exists():
            shutil.move(str(produced), str(coll))
        if coll.exists():
            shutil.copy2(coll, COLLISION_DIR / f"{slug}.collision.json")
            print(f"  collision -> {coll.name} "
                  f"({coll.stat().st_size / 1024:.0f} KB)")

        final_bytes = final.stat().st_size
        src_bytes = src.stat().st_size
        print(f"  final {final.name}: {final_bytes / 1024 / 1024:.2f} MB "
              f"(source {src_bytes / 1024 / 1024:.2f} MB, "
              f"{final_bytes / src_bytes:.0%})")


if __name__ == "__main__":
    main()
