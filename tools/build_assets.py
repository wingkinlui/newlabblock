"""Generate the web assets + manifest for the NewLabBlock site.

Reads the three source folders (FloorPlan, SnapShots, 3DSpace) from the project
root and writes into ``site/assets``:

* ``img/<name>.jpg``        web-sized JPEG (max 2560 px, quality 82, no EXIF)
* ``img/thumbs/<name>.jpg`` thumbnail JPEG (max 640 px, quality 72)
* ``models/<name>.glb``     the 3D captures (copied verbatim)
* ``manifest.json``         a machine readable index consumed by the site JS

EXIF is deliberately dropped: phone cameras store GPS coordinates, and this
site will be published to a public GitHub Pages URL.
"""

import json
import shutil
import struct
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
IMG_DIR = SITE / "assets" / "img"
THUMB_DIR = IMG_DIR / "thumbs"
MODEL_DIR = SITE / "assets" / "models"
COLLISION_DIR = SITE / "assets" / "collision"

MAX_FULL = 2560
MAX_THUMB = 640
FULL_QUALITY = 82
THUMB_QUALITY = 72

# Human readable captions for the source file names.
TITLES = {
    "5F_FloorPlan": "5th Floor Plan",
    "5F_FloorPlan_Overlaid": "5th Floor Plan (annotated)",
    "Building": "New Building - Exterior",
    "Corridor": "1/F Corridor",
    "F_Toilet": "Ground Floor Toilet",
    "M_Toilet": "2nd Floor Toilet",
    "M_Toilet_2": "2nd Floor Toilet (view 2)",
    "Greenhouse": "Greenhouse",
    "Greenhouse_2": "Greenhouse (view 2)",
    "Stairs": "Stairwell",
    "Stairs_1F": "Stairwell - Ground Floor",
    "TypeC_Lab": "Type C Laboratory",
}

# The two PolyCam captures. ``slug`` is used for the file name and for the
# model switcher in the viewer.
MODELS = [
    {
        "slug": "openlab",
        "title": "Open Lab",
        "subtitle": "Long open-plan laboratory - PolyCam capture, 27 Nov 2026",
        "source": Path("3DSpace") / "OpenLab" / "27_11_2026.glb",
    },
    {
        "slug": "typeclab",
        "title": "Type C Lab",
        "subtitle": "Type C laboratory - PolyCam capture",
        "source": Path("3DSpace") / "TypeCLab" / "TypeCLab.glb",
    },
    {
        "slug": "tfoffice",
        "title": "TF Office",
        "subtitle": "Supervisor's office - PolyCam capture",
        "source": Path("3DSpace") / "TFOFFICE" / "TF OFFICE.glb",
    },
]

GLB_MAGIC = 0x46546C67


def parse_glb(path: Path):
    """Return (gltf_json, image_bytes, geometry_bytes) for a .glb on disk.

    The published models are stored encrypted, so this may not be able to
    read them.  In that case the caller falls back to the values recorded in
    the manifest from the previous build.
    """
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path} is not a GLB file")

    gltf = None
    offset = 12
    while offset < length:
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:  # 'JSON'
            gltf = json.loads(chunk.decode("utf-8"))

    # Images live in buffer views; everything else is geometry.
    image_views = {img["bufferView"] for img in gltf.get("images", []) if "bufferView" in img}
    image_bytes = 0
    geometry_bytes = 0
    for idx, view in enumerate(gltf.get("bufferViews", [])):
        size = view.get("byteLength", 0)
        if idx in image_views:
            image_bytes += size
        else:
            geometry_bytes += size
    return gltf, image_bytes, geometry_bytes


def model_bounds(gltf):
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    found = False
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            pos = prim.get("attributes", {}).get("POSITION")
            if pos is None:
                continue
            acc = gltf["accessors"][pos]
            if "min" not in acc or "max" not in acc:
                continue
            found = True
            for i in range(3):
                lo[i] = min(lo[i], acc["min"][i])
                hi[i] = max(hi[i], acc["max"][i])
    if not found:
        return None
    return {
        "min": [round(v, 4) for v in lo],
        "max": [round(v, 4) for v in hi],
        "size": [round(hi[i] - lo[i], 4) for i in range(3)],
    }


def triangle_count(gltf):
    total = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                continue
            if "indices" in prim:
                total += gltf["accessors"][prim["indices"]]["count"] // 3
            else:
                total += gltf["accessors"][prim["attributes"]["POSITION"]]["count"] // 3
    return total


def title_for(stem: str) -> str:
    if stem in TITLES:
        return TITLES[stem]
    pretty = stem.replace("_", " ")
    return pretty[:1].upper() + pretty[1:]


def process_image(src: Path):
    """Write a web-sized JPEG + thumbnail, stripping all EXIF metadata."""
    stem = src.stem
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode != "RGB":
            im = im.convert("RGB")

        full = im.copy()
        full.thumbnail((MAX_FULL, MAX_FULL), Image.LANCZOS)
        full_path = IMG_DIR / f"{stem}.jpg"
        full.save(full_path, "JPEG", quality=FULL_QUALITY, optimize=True, progressive=True)

        thumb = im.copy()
        thumb.thumbnail((MAX_THUMB, MAX_THUMB), Image.LANCZOS)
        thumb_path = THUMB_DIR / f"{stem}.jpg"
        thumb.save(thumb_path, "JPEG", quality=THUMB_QUALITY, optimize=True, progressive=True)

        width, height = full.size
        return {
            "id": stem,
            "title": title_for(stem),
            "file": f"assets/img/{stem}.jpg",
            "thumb": f"assets/img/thumbs/{stem}.jpg",
            "width": width,
            "height": height,
            "bytes": full_path.stat().st_size,
            "originalBytes": src.stat().st_size,
            "originalName": src.name,
        }


def collect_images(src_dir: Path):
    if not src_dir.exists():
        print(f"! missing source folder: {src_dir}", file=sys.stderr)
        return []
    items = []
    for src in sorted(src_dir.iterdir()):
        if src.suffix.lower() in (".jpg", ".jpeg"):
            items.append(process_image(src))
    return items


def main():
    for directory in (IMG_DIR, THUMB_DIR, MODEL_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    manifest = {
        "floorPlan": collect_images(ROOT / "FloorPlan"),
        "snapshots": collect_images(ROOT / "SnapShots"),
        "models": [],
    }

    # Keep the figures from the previous build: the published models are
    # encrypted, so their metadata cannot be read back.
    previous_models = {}
    manifest_path = SITE / "assets" / "manifest.json"
    if manifest_path.exists():
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8"))
            previous_models = {m["id"]: m for m in old.get("models", [])}
        except (json.JSONDecodeError, KeyError):
            previous_models = {}

    for entry in MODELS:
        src = ROOT / entry["source"]
        slug = entry["slug"]
        dst = MODEL_DIR / f"{slug}.glb"
        if not src.exists():
            print(f"! missing model source: {src}", file=sys.stderr)
            continue
        if not dst.exists():
            print(f"! missing built model {dst} - run build_models.py first",
                  file=sys.stderr)
            continue

        item = {
            "id": slug,
            "title": entry["title"],
            "subtitle": entry["subtitle"],
            "file": f"assets/models/{slug}.glb",
            "sourceName": src.name,
            "bytes": dst.stat().st_size,
            "triangles": 0,
            "bounds": None,
            "textureBytes": 0,
            "geometryBytes": 0,
        }

        gltf = None
        image_bytes = geometry_bytes = 0
        try:
            gltf, image_bytes, geometry_bytes = parse_glb(dst)
        except ValueError:
            # The published model is encrypted; fall back to the numbers
            # recorded when it was built.
            previous = previous_models.get(slug)
            if previous:
                item["bytes"] = previous["bytes"]
                item["triangles"] = previous["triangles"]
                item["bounds"] = previous["bounds"]
                item["textureBytes"] = previous.get("textureBytes", 0)
                item["geometryBytes"] = previous.get("geometryBytes", 0)
            print(f"  note: {slug} is encrypted - kept the previous figures")
        else:
            item["bytes"] = dst.stat().st_size
            item["triangles"] = triangle_count(gltf)
            item["bounds"] = model_bounds(gltf)
            item["textureBytes"] = image_bytes
            item["geometryBytes"] = geometry_bytes

        # Merge the walkability data produced by build_models.py.
        collision_file = COLLISION_DIR / f"{slug}.collision.json"
        collision = None
        if collision_file.exists():
            try:
                collision = json.loads(collision_file.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                # The published grid is encrypted.
                collision = None

        if collision is not None:
            item["collision"] = f"assets/collision/{slug}.collision.json"
            item["floorY"] = collision["floorY"]
            item["ceilingY"] = collision["ceilingY"]
            item["spawn"] = collision["spawn"]
            item["heading"] = collision["heading"]
            item["floorArea"] = round(
                collision["walkable"] * collision["cell"] ** 2, 1)
            item["roomSize"] = collision["bounds"]["size"]
            item["objectArea"] = round(
                collision.get("objects", 0) * collision["cell"] ** 2, 1)
        else:
            # Fall back to the figures recorded in the previous manifest.
            previous = previous_models.get(slug, {})
            for key in ("collision", "floorY", "ceilingY", "spawn", "heading",
                        "floorArea", "roomSize", "objectArea"):
                if key in previous:
                    item[key] = previous[key]
            print(f"  note: {slug} collision grid is encrypted - "
                  f"kept the previous figures")

        manifest["models"].append(item)
        bounds = item.get("bounds") or {}
        print(f"model {slug}: {item['triangles']:,} tris, "
              f"{bounds.get('size', '-')} m, "
              f"{item['bytes'] / 1e6:.2f} MB")

    manifest_path = SITE / "assets" / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    total = 0
    for group in ("floorPlan", "snapshots"):
        for item in manifest[group]:
            print(f"{group:10s} {item['id']:24s} {item['width']}x{item['height']} "
                  f"{item['bytes'] / 1024:.0f} KB (from {item['originalBytes'] / 1024 / 1024:.1f} MB)")
            total += item["bytes"]
    print(f"\nimages total {total / 1024 / 1024:.1f} MB")
    print(f"manifest -> {manifest_path}")


if __name__ == "__main__":
    main()
