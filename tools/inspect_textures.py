"""Report the embedded texture formats/sizes of each .glb capture.

PolyCam usually embeds JPEG textures; if they are PNG the files can be much
larger than needed for a web viewer.
"""

import json
import struct
import sys
from pathlib import Path

GLB_MAGIC = 0x46546C67


def main():
    for raw in sys.argv[1:]:
        path = Path(raw)
        data = path.read_bytes()
        magic, version, length = struct.unpack_from("<III", data, 0)
        if magic != GLB_MAGIC:
            print(f"{path}: not a glb")
            continue

        gltf = None
        binary = None
        offset = 12
        while offset < length:
            chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
            offset += 8
            chunk = data[offset:offset + chunk_len]
            offset += chunk_len
            if chunk_type == 0x4E4F534A:
                gltf = json.loads(chunk.decode("utf-8"))
            elif chunk_type == 0x004E4942:
                binary = chunk

        print("=" * 70)
        print(f"{path.name}  ({path.stat().st_size / 1024 / 1024:.2f} MB)")

        views = gltf.get("bufferViews", [])
        total_tex = 0
        for img in gltf.get("images", []):
            bv = img.get("bufferView")
            size = views[bv]["byteLength"] if bv is not None else 0
            total_tex += size
            mime = img.get("mimeType", "?")
            w = h = None
            if bv is not None:
                # read the actual bytes to get real pixel dimensions
                start = views[bv].get("byteOffset", 0)
                blob = binary[start:start + size]
                w, h = sniff_size(blob, mime)
            print(f"  image: mime={mime:12s} bytes={size / 1024:9.0f} KB "
                  f"dims={w}x{h}")

        # Also show UV channel usage (PolyCam sometimes ships UV > 1).
        for mesh in gltf.get("meshes", []):
            for prim in mesh.get("primitives", []):
                uv = [k for k in prim.get("attributes", {}) if k.startswith("TEXCOORD")]
                if uv:
                    acc = gltf["accessors"][prim["attributes"][uv[0]]]
                    print(f"  texcoord set: {uv} type={acc['type']}")
                    break

        print(f"  -> embedded textures: {total_tex / 1024 / 1024:.2f} MB of "
              f"{path.stat().st_size / 1024 / 1024:.2f} MB")


def sniff_size(blob: bytes, mime: str):
    """Best-effort pixel dimensions of an embedded PNG or JPEG."""
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return (struct.unpack_from(">I", blob, 16)[0],
                struct.unpack_from(">I", blob, 20)[0])
    if blob[:2] == b"\xff\xd8":
        i = 2
        n = len(blob)
        while i < n - 9:
            if blob[i] != 0xFF:
                i += 1
                continue
            marker = blob[i + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg_len = struct.unpack_from(">H", blob, i + 2)[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h = struct.unpack_from(">H", blob, i + 5)[0]
                w = struct.unpack_from(">H", blob, i + 7)[0]
                return (w, h)
            i += 2 + seg_len
    return (None, None)


if __name__ == "__main__":
    main()
