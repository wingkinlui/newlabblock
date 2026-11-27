"""Downscale the textures embedded in a PolyCam .glb for web delivery.

PolyCam embeds 4096x4096 JPEG textures (8.6 MB of the 15 MB OpenLab file).
For a browser viewer 2048 px is indistinguishable in practice and cuts the
download by roughly two thirds.

The script rewrites the single embedded binary chunk: every buffer view is
copied in order, image views are replaced with the re-encoded JPEG, and the
bufferView byteOffset/byteLength entries are updated to match.

Usage:
    python optimize_glb.py <in.glb> <out.glb> [--max 2048] [--quality 82]
"""

import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
ALIGN = 4


def read_glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path} is not a GLB file")
    gltf = None
    binary = b""
    offset = 12
    while offset < length:
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + chunk_len]
        offset += chunk_len
        if chunk_type == CHUNK_JSON:
            gltf = json.loads(chunk.decode("utf-8"))
        elif chunk_type == CHUNK_BIN:
            binary = chunk
    return gltf, binary


def write_glb(path: Path, gltf: dict, binary: bytes):
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (-len(json_bytes)) % 4
    json_bytes += b" " * json_pad

    bin_pad = (-len(binary)) % 4
    bin_bytes = binary + b"\x00" * bin_pad

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(json_bytes), CHUNK_JSON) + json_bytes
    if bin_bytes:
        out += struct.pack("<II", len(bin_bytes), CHUNK_BIN) + bin_bytes
    path.write_bytes(bytes(out))


def resize_image(blob: bytes, max_dim: int, quality: int):
    """Return (new_bytes, width, height) with the image capped at max_dim."""
    with Image.open(io.BytesIO(blob)) as im:
        im = ImageOps_fix(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        w, h = im.size
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
        return buf.getvalue(), im.size[0], im.size[1]


def ImageOps_fix(im):
    """Apply EXIF orientation then drop the EXIF block."""
    from PIL import ImageOps
    return ImageOps.exif_transpose(im)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    max_dim = 2048
    quality = 82
    for a in sys.argv[1:]:
        if a.startswith("--max"):
            max_dim = int(a.split("=", 1)[1]) if "=" in a else int(sys.argv[sys.argv.index(a) + 1])
        if a.startswith("--quality"):
            quality = int(a.split("=", 1)[1]) if "=" in a else int(sys.argv[sys.argv.index(a) + 1])

    src, dst = Path(args[0]), Path(args[1])
    gltf, binary = read_glb(src)

    views = gltf.get("bufferViews", [])
    image_views = {}
    for img in gltf.get("images", []):
        if "bufferView" in img:
            image_views[img["bufferView"]] = img

    if not image_views:
        print(f"{src.name}: no embedded images, copying verbatim")
        write_glb(dst, gltf, binary)
        return

    # Rebuild the binary chunk view by view.
    new_binary = bytearray()
    saved = 0
    for idx, view in enumerate(views):
        start = view.get("byteOffset", 0)
        length = view.get("byteLength", 0)
        blob = binary[start:start + length]
        if idx in image_views:
            new_blob, w, h = resize_image(blob, max_dim, quality)
            saved += length - len(new_blob)
            print(f"  view {idx}: {length / 1024:.0f} KB -> {len(new_blob) / 1024:.0f} KB "
                  f"({w}x{h})")
            blob = new_blob
        while len(new_binary) % ALIGN:
            new_binary.append(0)
        view["byteOffset"] = len(new_binary)
        view["byteLength"] = len(blob)
        new_binary.extend(blob)

    gltf["bufferViews"] = views
    write_glb(dst, gltf, bytes(new_binary))

    ratio = dst.stat().st_size / src.stat().st_size
    print(f"{src.name}: {src.stat().st_size / 1024 / 1024:.2f} MB -> "
          f"{dst.stat().st_size / 1024 / 1024:.2f} MB ({ratio:.0%}), "
          f"saved {saved / 1024 / 1024:.2f} MB of texture data")


if __name__ == "__main__":
    main()
