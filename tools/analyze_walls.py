"""Work out how to tell room walls apart from furniture / construction clutter.

IMPORTANT: the ceiling covers every cell, so the "tallest hit" must be
measured *below* the ceiling, otherwise every cell looks like a wall.

For every cell with floor we record:

    top_below_ceiling   the highest geometry that is not the ceiling
    ceiling_hits        how much ceiling geometry sits above the cell

A wall reaches from the floor up to the ceiling, so top_below_ceiling is
close to the room height.  A bench, a desk or a pile of building materials
stops far below that.

Usage:
    python analyze_walls.py <model.glb> [...]
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_collision import load_glb, triangles


def analyse(path, cell=0.15):
    gltf, binary = load_glb(path)
    tris = triangles(gltf, binary)
    print("=" * 78)
    print(Path(path).name, f"({len(tris):,} triangles)")

    lo = tris.min(axis=1)
    hi = tris.max(axis=1)
    cy = tris[:, :, 1].mean(axis=1)
    cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    area = 0.5 * np.linalg.norm(cross, axis=1)
    up = cross[:, 1] > 0

    up_area, down_area = {}, {}
    for y, ar, u in zip(cy, area, up):
        key = round(float(y) / 0.05) * 0.05
        if u:
            up_area[key] = up_area.get(key, 0.0) + float(ar)
        else:
            down_area[key] = down_area.get(key, 0.0) + float(ar)
    floor_y = max(up_area.items(), key=lambda kv: kv[1])[0]
    ceil_y = max(down_area.items(), key=lambda kv: kv[1])[0]
    room_h = ceil_y - floor_y
    print(f"  floor {floor_y:+.2f}  ceiling {ceil_y:+.2f}  height {room_h:.2f} m")

    floor_mask = (hi[:, 1] - lo[:, 1] < 0.08) & (np.abs(cy - floor_y) < 0.12)
    pts = tris[floor_mask][:, :, [0, 2]].reshape(-1, 2)
    min_x, max_x = float(pts[:, 0].min()) - cell, float(pts[:, 0].max()) + cell
    min_z, max_z = float(pts[:, 1].min()) - cell, float(pts[:, 1].max()) + cell
    nx = int(np.ceil((max_x - min_x) / cell))
    nz = int(np.ceil((max_z - min_z) / cell))

    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    samples = np.concatenate([
        a, b, c, (a + b) / 2.0, (b + c) / 2.0, (a + c) / 2.0,
        (a + b + c) / 3.0,
    ], axis=0)
    sx = np.floor((samples[:, 0] - min_x) / cell).astype(np.int64)
    sz = np.floor((samples[:, 2] - min_z) / cell).astype(np.int64)
    sy = samples[:, 1]
    inside = (sx >= 0) & (sx < nx) & (sz >= 0) & (sz < nz)
    ix, iz, iy = sx[inside], sz[inside], sy[inside]

    # Ceiling samples are the ones close to the ceiling plane.
    is_ceiling = np.abs(iy - ceil_y) < 0.25
    body_y = iy[~is_ceiling]
    body_ix, body_iz = ix[~is_ceiling], iz[~is_ceiling]

    INF = np.float32(1e9)
    ymin = np.full((nz, nx), INF, dtype=np.float32)
    ymax = np.full((nz, nx), -INF, dtype=np.float32)
    np.minimum.at(ymin, (iz, ix), iy.astype(np.float32))
    np.maximum.at(ymax, (iz, ix), iy.astype(np.float32))

    top = np.full((nz, nx), -INF, dtype=np.float32)
    np.maximum.at(top, (body_iz, body_ix), body_y.astype(np.float32))

    has_geom = ymax > -INF
    has_floor = has_geom & (np.abs(ymin - floor_y) < 0.22)
    has_top = top > -INF

    # Height of the tallest non-ceiling geometry above the floor.
    obh = np.where(has_top, top - floor_y, 0.0)

    print("\n  tallest NON-ceiling geometry above the floor (floor cells only):")
    vals = obh[has_floor & has_top]
    bins = [(0, 0.3), (0.3, 0.8), (0.8, 1.3), (1.3, 1.8), (1.8, 2.2),
            (2.2, 2.4), (2.4, 2.6), (2.6, 99)]
    for lo_h, hi_h in bins:
        n = int(((vals >= lo_h) & (vals < hi_h)).sum())
        pct = 100.0 * n / max(1, len(vals))
        print(f"    {lo_h:4.1f} - {hi_h:4.1f} m : {n:6d}  {pct:5.1f}%  "
              + "#" * int(pct / 2))

    body_lo, body_hi = floor_y + 0.25, floor_y + 1.85
    in_body = (ymax > body_lo) & (ymin < body_hi)
    current = int((has_floor & in_body).sum())
    print(f"\n  current (body band) blocked cells : {current}")
    for cut in (1.6, 1.8, 2.0, 2.2, 2.4):
        tall = int((has_floor & has_top & (obh >= cut)).sum())
        print(f"  >= {cut:.1f} m tall cells          : {tall}  "
              f"(would free up {current - tall})")

    print("\n  map:  # tall, x other obstacle, . open, , no floor")
    for row in range(nz - 1, -1, -1):
        line = []
        for col in range(nx):
            if not has_floor[row, col]:
                line.append(",")
            elif has_top[row, col] and obh[row, col] >= 2.0:
                line.append("#")
            elif in_body[row, col]:
                line.append("x")
            else:
                line.append(".")
        if row % 2 == 0:
            print(f"    z={min_z + row * cell:7.2f} |{''.join(line)}|")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyse(p)

