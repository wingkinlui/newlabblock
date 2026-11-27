"""Find the floor level, walkable area and a good camera spawn for a .glb.

The viewer needs three facts that cannot be guessed reliably:

1. the floor height (PolyCam puts the capture origin at an arbitrary point),
2. where there is open floor to spawn the camera in,
3. a sensible initial heading.

Method: bucket horizontal triangles by Y and sum their area (up-facing vs
down-facing) -> the floor is the largest up-facing plane.  Then rasterise the
floor into an XZ occupancy grid, mark cells covered by geometry as blocked and
look for the most open cell to spawn in.
"""

import json
import struct
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

FLOAT, USHORT, UINT = 5126, 5123, 5125


def load_glb(path):
    data = Path(path).read_bytes()
    magic, _v, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError("not a glb")
    gltf = binary = None
    offset = 12
    while offset < length:
        clen, ctype = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + clen]
        offset += clen
        if ctype == 0x4E4F534A:
            gltf = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            binary = chunk
    return gltf, binary


def acc(gltf, binary, index):
    a = gltf["accessors"][index]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}.get(a["type"], 1)
    dtype = {FLOAT: "<f4", USHORT: "<u2", UINT: "<u4"}[a["componentType"]]
    view = gltf["bufferViews"][a["bufferView"]]
    base = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    arr = np.frombuffer(binary, dtype=dtype, count=a["count"] * ncomp, offset=base)
    return arr if ncomp == 1 else arr.reshape(-1, ncomp)


def analyse(path):
    gltf, binary = load_glb(path)
    print("=" * 74)
    print(Path(path).name)

    tris = []
    tri_area, tri_cy, tri_up = [], [], []
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            attrs = prim.get("attributes", {})
            if "POSITION" not in attrs:
                continue
            pos = acc(gltf, binary, attrs["POSITION"])
            if "indices" in prim:
                idx = acc(gltf, binary, prim["indices"]).astype(np.int64).ravel()
            else:
                idx = np.arange(len(pos), dtype=np.int64)
            a, b, c = pos[idx[0::3]], pos[idx[1::3]], pos[idx[2::3]]
            cross = np.cross(b - a, c - a)
            area = 0.5 * np.linalg.norm(cross, axis=1)
            cy = (a[:, 1] + b[:, 1] + c[:, 1]) / 3.0
            tris.append(np.stack([a, b, c], axis=1))
            tri_area.append(area)
            tri_cy.append(cy)
            tri_up.append(cross[:, 1] > 0)

    verts = np.concatenate(tris, axis=0)
    area = np.concatenate(tri_area)
    cy = np.concatenate(tri_cy)
    up = np.concatenate(tri_up)

    up_area, down_area = defaultdict(float), defaultdict(float)
    for y, ar, u in zip(cy, area, up):
        key = round(float(y) / 0.05) * 0.05
        (up_area if u else down_area)[key] += float(ar)

    print("  UP-facing planes (candidate floors):")
    for y, ar in sorted(up_area.items(), key=lambda kv: -kv[1])[:5]:
        print(f"    y={y:+.2f}  area={ar:8.1f} m2")
    print("  DOWN-facing planes (candidate ceilings):")
    for y, ar in sorted(down_area.items(), key=lambda kv: -kv[1])[:5]:
        print(f"    y={y:+.2f}  area={ar:8.1f} m2")

    floor_y = max(up_area.items(), key=lambda kv: kv[1])[0] if up_area else 0.0
    ceil_y = max(down_area.items(), key=lambda kv: kv[1])[0] if down_area else 0.0
    print(f"  => FLOOR y={floor_y:+.2f}   CEILING y={ceil_y:+.2f}   "
          f"headroom={ceil_y - floor_y:.2f} m")

    # Occupancy grid at floor level.
    cell = 0.25
    occ = set()
    for tri, c_y in zip(verts, cy):
        if abs(c_y - floor_y) > 0.30:
            continue
        gx0 = int(np.floor(tri[:, 0].min() / cell))
        gx1 = int(np.floor(tri[:, 0].max() / cell))
        gz0 = int(np.floor(tri[:, 2].min() / cell))
        gz1 = int(np.floor(tri[:, 2].max() / cell))
        for gx in range(gx0, gx1 + 1):
            for gz in range(gz0, gz1 + 1):
                occ.add((gx, gz))

    if not occ:
        print("  ! no footprint found")
        return

    gxs = sorted({c[0] for c in occ})
    gzs = sorted({c[1] for c in occ})
    print(f"  footprint {len(gxs) * cell:.1f} x {len(gzs) * cell:.1f} m, "
          f"{len(occ)} occupied cells")

    best = None
    for cx in range(gxs[0], gxs[-1] + 1):
        for cz in range(gzs[0], gzs[-1] + 1):
            if (cx, cz) in occ:
                continue
            clear = min(max(abs(cx - ox), abs(cz - oz)) for ox, oz in occ)
            if best is None or clear > best[0]:
                best = (clear, cx, cz)
    if best:
        cl, cx, cz = best
        sx, sz = (cx + 0.5) * cell, (cz + 0.5) * cell
        print(f"  => SPAWN x={sx:.2f} z={sz:.2f} y={floor_y + 1.6:.2f} "
              f"(clearance {cl * cell:.2f} m)")
        # Heading: towards the most open direction (longest straight run).
        best_dir, best_len = None, -1.0
        for deg in range(0, 360, 15):
            dx, dz = np.cos(np.radians(deg)), np.sin(np.radians(deg))
            length = 0.0
            for step in range(1, 60):
                gx = int(np.floor((sx + dx * step * cell) / cell))
                gz = int(np.floor((sz + dz * step * cell) / cell))
                if (gx, gz) in occ:
                    break
                length = step * cell
            if length > best_len:
                best_len, best_dir = length, deg
        print(f"  => HEADING {best_dir} deg (clear run {best_len:.2f} m)")

    print("  occupancy map (# = blocked, . = open):")
    for row in range(gzs[-1], gzs[0] - 1, -1):
        print(f"    z={row * cell:7.2f} " +
              "".join("#" if (gx0, row) in occ else "."
                      for gx0 in range(gxs[0], gxs[-1] + 1)))
    print(f"    x from {gxs[0] * cell:.2f} to {gxs[-1] * cell:.2f}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyse(p)

