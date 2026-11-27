"""Analyse a PolyCam .glb to find the floor level and mesh roles.

Prints, for every mesh in the file:
  * world bounding box
  * vertex count / triangle count
  * a histogram of vertex Y values (peaks = floor, ceiling, worktops)

That is used to place the default camera spawn inside the room rather than
inside a wall, and to size the collision capsule.
"""

import json
import struct
import sys
from collections import Counter
from pathlib import Path

import numpy as np

GLB_MAGIC = 0x46546C67
FLOAT = 5126
USHORT = 5123
UINT = 5125


def load_glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError("not a glb")
    gltf, binary = None, None
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
    return gltf, binary


def accessor_array(gltf, binary, index):
    """Read an accessor as a numpy array (positions/indices only)."""
    acc = gltf["accessors"][index]
    n = acc["count"]
    ctype = acc["componentType"]
    dtype = {FLOAT: "<f4", USHORT: "<u2", UINT: "<u4"}.get(ctype)
    if dtype is None:
        return None
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}.get(acc["type"], 1)

    view = gltf["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = n * ncomp
    arr = np.frombuffer(binary, dtype=dtype, count=count, offset=base)
    if ncomp == 1:
        return arr
    return arr.reshape(n, ncomp)


def main():
    for raw in sys.argv[1:]:
        path = Path(raw)
        gltf, binary = load_glb(path)
        print("=" * 74)
        print(path.name)

        all_y = []
        for mesh in gltf.get("meshes", []):
            lo = np.array([np.inf] * 3)
            hi = np.array([-np.inf] * 3)
            tris = 0
            ys = []
            for prim in mesh.get("primitives", []):
                pos = accessor_array(gltf, binary, prim["attributes"]["POSITION"])
                if pos is None:
                    continue
                lo = np.minimum(lo, pos.min(axis=0))
                hi = np.maximum(hi, pos.max(axis=0))
                ys.append(pos[:, 1])
                if "indices" in prim:
                    idx = accessor_array(gltf, binary, prim["indices"])
                    tris += len(idx) // 3
                else:
                    tris += len(pos) // 3
            ys = np.concatenate(ys) if ys else np.array([0.0])
            all_y.append(ys)

            size = hi - lo
            print(f"  mesh {mesh.get('name', '') or '(unnamed)'}: {tris:,} tris")
            print(f"    bbox [{', '.join(f'{v:.2f}' for v in lo)}] -> "
                  f"[{', '.join(f'{v:.2f}' for v in hi)}]  size "
                  f"[{', '.join(f'{v:.2f}' for v in size)}]")

            # horizontal-ish surfaces: quantise Y into 5 cm buckets
            hist = Counter((np.round(ys / 0.05) * 0.05).tolist())
            top = hist.most_common(4)
            print("    dominant Y planes: " +
                  ", ".join(f"y={y:.2f} ({c:,} v)" for y, c in top))

        all_y = np.concatenate(all_y)
        hist = Counter((np.round(all_y / 0.05) * 0.05).tolist())
        print("  GLOBAL dominant Y planes:")
        for y, c in hist.most_common(8):
            print(f"    y={y:.2f}  {c:,} vertices")

        # The floor is the dominant low plane; the ceiling the dominant high one.
        lo_plane = min(hist.items(), key=lambda kv: kv[0])
        hi_plane = max(hist.items(), key=lambda kv: kv[0])
        print(f"  => floor candidate y={lo_plane[0]:.2f}, "
              f"ceiling candidate y={hi_plane[0]:.2f}")


if __name__ == "__main__":
    main()
