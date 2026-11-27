"""Build a 2D collision / walkability grid for each PolyCam capture.

The viewer walks a first-person camera around the room.  To do that reliably
we need to know, for every point on the floor plan:

  * is there floor there at all?        (0 = void, outside the capture)
  * is it a wall or room boundary?       (1 = wall, always blocks)
  * is it an obstacle in the room?       (3 = object, blocks only in
                                                "solid objects" mode)
  * is it open floor?                    (2 = walkable)

Method
------
Every triangle is sampled (vertices + edge midpoints + centroid) and the
samples are scattered into an XZ grid.  Per cell we record the vertical
extent of the geometry, split into "floor level", "body band" (the height a
person occupies) and "above the ceiling" (the ceiling itself, which must be
ignored - otherwise every cell looks like a wall).

The classification is then:

  * **walls**   - non-ceiling geometry that reaches high up (a partition or
                  the outer wall), or cells at the perimeter of the floor
                  region (the boundary of the scanned space),
  * **objects** - geometry in the body band that is not a wall: benches,
                  desks, building materials.  These are clipped through by
                  default so that construction clutter cannot block the way.
"""

import json
import struct
import sys
from pathlib import Path

import numpy as np

FLOAT, USHORT, UINT = 5126, 5123, 5125
VOID, BLOCKED, WALKABLE, OBJECT = 0, 1, 2, 3


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


def triangles(gltf, binary):
    """Return an (N, 3, 3) array of triangle vertex positions."""
    out = []
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
            out.append(np.stack([pos[idx[0::3]], pos[idx[1::3]], pos[idx[2::3]]], axis=1))
    return np.concatenate(out, axis=0) if out else np.zeros((0, 3, 3))


def rle_encode(values):
    """Run-length encode a row of ints into [[value, count], ...]."""
    out = []
    for v in values:
        if out and out[-1][0] == v:
            out[-1][1] += 1
        else:
            out.append([int(v), 1])
    return out



def analyse(path, cell=0.15):
    gltf, binary = load_glb(path)
    tris = triangles(gltf, binary)
    print("=" * 74)
    print(Path(path).name, f"({len(tris):,} triangles)")

    lo = tris.min(axis=1)
    hi = tris.max(axis=1)
    span = hi[:, 1] - lo[:, 1]
    cy = tris[:, :, 1].mean(axis=1)
    cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    area = 0.5 * np.linalg.norm(cross, axis=1)
    facing_up = cross[:, 1] > 0

    up_area, down_area = {}, {}
    for y, ar, up in zip(cy, area, facing_up):
        key = round(float(y) / 0.05) * 0.05
        if up:
            up_area[key] = up_area.get(key, 0.0) + float(ar)
        else:
            down_area[key] = down_area.get(key, 0.0) + float(ar)

    floor_y = max(up_area.items(), key=lambda kv: kv[1])[0]
    ceil_y = max(down_area.items(), key=lambda kv: kv[1])[0]
    print(f"  floor y={floor_y:+.2f}  ceiling y={ceil_y:+.2f}  "
          f"height {ceil_y - floor_y:.2f} m")

    # Grid bounds from the floor triangles only (that is the room footprint).
    floor_mask = span < 0.08
    floor_mask &= np.abs(cy - floor_y) < 0.12
    if floor_mask.sum() < 10:
        floor_mask = np.abs(cy - floor_y) < 0.25

    pts = tris[floor_mask][:, :, [0, 2]].reshape(-1, 2)
    min_x, max_x = float(pts[:, 0].min()), float(pts[:, 0].max())
    min_z, max_z = float(pts[:, 1].min()), float(pts[:, 1].max())
    min_x -= cell; min_z -= cell; max_x += cell; max_z += cell
    nx = int(np.ceil((max_x - min_x) / cell))
    nz = int(np.ceil((max_z - min_z) / cell))
    print(f"  grid {nx} x {nz} cells of {cell} m  "
          f"(x {min_x:.2f}..{max_x:.2f}, z {min_z:.2f}..{max_z:.2f})")

    grid = np.zeros((nz, nx), dtype=np.uint8)  # 0 = void

    # Scatter every triangle's samples into the grid.
    # 7 samples per triangle: 3 vertices, 3 edge midpoints, 1 centroid.
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    samples = np.concatenate([
        a, b, c,
        (a + b) / 2.0, (b + c) / 2.0, (a + c) / 2.0,
        (a + b + c) / 3.0,
    ], axis=0)
    sx = np.floor((samples[:, 0] - min_x) / cell).astype(np.int64)
    sz = np.floor((samples[:, 2] - min_z) / cell).astype(np.int64)
    sy = samples[:, 1]
    inside = (sx >= 0) & (sx < nx) & (sz >= 0) & (sz < nz)

    # A vertical ray through a cell tells us what is there.  The ceiling has to
    # be excluded, otherwise every cell looks like a wall.
    ix, iz, iy = sx[inside], sz[inside], sy[inside]

    body_lo = floor_y + 0.25
    body_hi = floor_y + 1.85

    is_ceiling = np.abs(iy - ceil_y) < 0.30
    body_y = iy[~is_ceiling]
    body_ix = ix[~is_ceiling]
    body_iz = iz[~is_ceiling]

    INF = np.float32(1e9)
    # Lowest / highest geometry per cell (ceiling included).
    ymin = np.full((nz, nx), INF, dtype=np.float32)
    ymax = np.full((nz, nx), -INF, dtype=np.float32)
    np.minimum.at(ymin, (iz, ix), iy.astype(np.float32))
    np.maximum.at(ymax, (iz, ix), iy.astype(np.float32))

    # Highest geometry that is not the ceiling: this is what tells a wall
    # (reaches up to the ceiling) from a bench (stops at bench height).
    top = np.full((nz, nx), -INF, dtype=np.float32)
    np.maximum.at(top, (body_iz, body_ix), body_y.astype(np.float32))

    has_geom = ymax > -INF
    has_floor = has_geom & (np.abs(ymin - floor_y) < 0.22)
    has_top = top > -INF

    # Something in the band a person walks through.
    in_body = np.zeros((nz, nx), dtype=bool)
    band = (body_y > body_lo) & (body_y < body_hi)
    np.logical_or.at(in_body, (body_iz[band], body_ix[band]), True)

    # Height of the tallest non-ceiling geometry above the floor.
    obh = np.where(has_top, top - floor_y, 0.0)

    # --- walls ---------------------------------------------------------
    # A wall reaches well above head height.  The threshold is relative to the
    # room so that it also works for the smaller offices.
    wall_height = min(2.0, 0.75 * (ceil_y - floor_y))
    tall = has_top & (obh >= wall_height)

    # The perimeter of the floor region is the boundary of the scanned space
    # even where the geometry is not tall enough to be recognised as a wall.
    # A cell counts as perimeter when it is within one cell of a cell that has
    # no floor.
    not_floor = ~has_floor
    perimeter = np.zeros((nz, nx), dtype=bool)
    for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        shifted = np.roll(not_floor, (dz, dx), axis=(0, 1))
        perimeter |= shifted
    perimeter &= has_floor

    wall = has_floor & (tall | perimeter)

    # --- objects -------------------------------------------------------
    object_cell = has_floor & in_body & ~wall

    grid = np.zeros((nz, nx), dtype=np.uint8)
    grid[has_floor & ~in_body] = WALKABLE
    grid[object_cell] = OBJECT
    grid[wall] = BLOCKED

    print(f"  samples inside grid: {int(inside.sum())}  "
          f"floor cells={int(has_floor.sum())}")
    print(f"  wall threshold: {wall_height:.2f} m   "
          f"walls={int(wall.sum())} (tall {int((has_floor & tall).sum())}, "
          f"perimeter {int((has_floor & perimeter).sum())})   "
          f"objects={int(object_cell.sum())}   "
          f"open={int((grid == WALKABLE).sum())}")


    # Fill single-cell holes inside walkable areas (sampling noise).
    for _ in range(2):
        walk = grid == WALKABLE
        padded = np.pad(walk, 1, constant_values=False)
        neigh = (padded[:-2, 1:-1] & padded[2:, 1:-1] &
                 padded[1:-1, :-2] & padded[1:-1, 2:])
        grid[neigh & (grid == VOID)] = WALKABLE

    n_walk = int((grid == WALKABLE).sum())
    n_block = int((grid == BLOCKED).sum())
    n_obj = int((grid == OBJECT).sum())
    print(f"  walkable {n_walk} cells ({n_walk * cell * cell:.1f} m2), "
          f"walls {n_block} cells ({n_block * cell * cell:.1f} m2), "
          f"objects {n_obj} cells ({n_obj * cell * cell:.1f} m2)")

    # --- spawn point ----------------------------------------------------
    # Prefer a spot far from any wall (so the camera is not jammed against
    # one) and reasonably central.  Objects are ignored here: they are
    # clipped through anyway.
    walk_idx = np.argwhere(grid == WALKABLE)
    if len(walk_idx):
        blocked_idx = np.argwhere(grid == BLOCKED)
        best = None
        for (iz, ix) in walk_idx:
            if len(blocked_idx):
                d = np.max(np.abs(blocked_idx - np.array([iz, ix])), axis=1).min()
            else:
                d = 99
            # Prefer clearance, then centralness.
            centre = np.hypot(ix - nx / 2, iz - nz / 2)
            score = d * 4.0 - centre * 0.15
            if best is None or score > best[0]:
                best = (score, d, ix, iz)
        _score, d, ix, iz = best
        sx = min_x + (ix + 0.5) * cell
        sz = min_z + (iz + 0.5) * cell
        print(f"  => SPAWN x={sx:.2f} z={sz:.2f} "
              f"(clearance {d * cell:.2f} m)")

        # Heading with the longest clear straight run.  Only walls stop the
        # ray - objects can be walked through.
        best_dir, best_len = 0.0, -1.0
        for deg in range(0, 360, 15):
            dx, dz = np.cos(np.radians(deg)), np.sin(np.radians(deg))
            length = 0.0
            for step in range(1, 80):
                gx = int((sx + dx * step * cell - min_x) / cell)
                gz = int((sz + dz * step * cell - min_z) / cell)
                if gx < 0 or gx >= nx or gz < 0 or gz >= nz:
                    break
                if grid[gz, gx] == BLOCKED:
                    break
                length = step * cell
            if length > best_len:
                best_len, best_dir = length, deg
        print(f"  => HEADING {best_dir:.0f} deg (clear run {best_len:.2f} m)")

    # --- encode ---------------------------------------------------------
    rows = [rle_encode(row.tolist()) for row in grid]
    encoded = []
    for row in rows:
        encoded.append([v for pair in row for v in pair])

    all_pts = tris.reshape(-1, 3)
    bounds = {
        "min": [round(float(all_pts[:, i].min()), 4) for i in range(3)],
        "max": [round(float(all_pts[:, i].max()), 4) for i in range(3)],
    }
    bounds["size"] = [round(bounds["max"][i] - bounds["min"][i], 4) for i in range(3)]

    payload = {
        "cell": cell,
        "origin": [round(min_x, 4), round(min_z, 4)],
        "width": nx,
        "height": nz,
        "floorY": round(float(floor_y), 4),
        "ceilingY": round(float(ceil_y), 4),
        "bounds": bounds,
        "triangles": int(len(tris)),
        "spawn": [round(float(sx), 3), round(float(floor_y + 1.60), 3), round(float(sz), 3)],
        "heading": round(float(best_dir), 1),
        "walkable": n_walk,
        "blocked": n_block,
        "objects": n_obj,
        "rle": encoded,
    }
    out_path = Path(path).with_suffix(".collision.json")
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {out_path.name} ({out_path.stat().st_size / 1024:.0f} KB)")

    # ASCII preview.
    print("  grid preview (W walkable, # wall, o object, . void):")
    for row in range(nz - 1, -1, -1):
        line = "".join({WALKABLE: "W", BLOCKED: "#", OBJECT: "o", VOID: "."}[v]
                        for v in grid[row].tolist())
        if row % 2 == 0:
            print(f"    z={min_z + row * cell:7.2f} {line}")
    return payload


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyse(p)
