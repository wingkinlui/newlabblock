"""Find the boundary of the walkable floor area.

The room boundary is not a height test - almost all of the floor has
something reaching the ceiling.  What defines the boundary is the *edge of
the floor*: outside the room there is no floor, and the perimeter is a band of
geometry right at the edge of that floor region.

This script rasterises the floor and looks at how the distance to the edge of
the floor region varies, to see whether a "near the edge" band separates the
walls from the clutter in the middle.
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
    print(Path(path).name)

    lo = tris.min(axis=1)
    hi = tris.max(axis=1)
    cy = tris[:, :, 1].mean(axis=1)
    cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    area = 0.5 * np.linalg.norm(cross, axis=1)
    up = cross[:, 1] > 0

    up_area, down_area = {}, {}
    for y, ar, u in zip(cy, area, up):
        key = round(float(y) / 0.05) * 0.05
        (up_area if u else down_area)[key] = up_area.get(key, 0.0) + float(ar) \
            if u else down_area.get(key, 0.0) + float(ar)
    floor_y = max(up_area.items(), key=lambda kv: kv[1])[0]
    ceil_y = max(down_area.items(), key=lambda kv: kv[1])[0]

    floor_mask = (hi[:, 1] - lo[:, 1] < 0.08) & (np.abs(cy - floor_y) < 0.12)
    pts = tris[floor_mask][:, :, [0, 2]].reshape(-1, 2)
    min_x, max_x = float(pts[:, 0].min()) - cell, float(pts[:, 0].max()) + cell
    min_z, max_z = float(pts[:, 1].min()) - cell, float(pts[:, 1].max()) + cell
    nx = int(np.ceil((max_x - min_x) / cell))
    nz = int(np.ceil((max_z - min_z) / cell))

    # Floor mask + vertical extent per cell.
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

    INF = np.float32(1e9)
    ymin = np.full((nz, nx), INF, dtype=np.float32)
    ymax = np.full((nz, nx), -INF, dtype=np.float32)
    np.minimum.at(ymin, (iz, ix), iy.astype(np.float32))
    np.maximum.at(ymax, (iz, ix), iy.astype(np.float32))

    has_floor = (ymax > -INF) & (np.abs(ymin - floor_y) < 0.22)

    # Distance (in cells) from every floor cell to the nearest non-floor cell.
    dist = np.full((nz, nx), 9999, dtype=np.int32)
    frontier = ~has_floor
    dist[frontier] = 0
    # Simple BFS dilation.
    for step in range(1, 40):
        padded = np.pad(dist, 1, constant_values=9999)
        dist = np.minimum(dist, np.minimum.reduce([
            padded[:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, :-2], padded[1:-1, 2:],
        ]))
        dist[~has_floor] = 0
        if (dist[has_floor] > step).sum() == 0:
            break

    print(f"  floor cells: {int(has_floor.sum())}")
    print("\n  distance from the floor edge (cells) vs. tallest geometry:")
    body_lo, body_hi = floor_y + 0.25, floor_y + 1.85
    in_body = (ymax > body_lo) & (ymin < body_hi)
    for d in range(0, 9):
        sel = has_floor & (dist == d)
        n = int(sel.sum())
        if not n:
            continue
        blocked = int((sel & in_body).sum())
        tall = int((sel & (ymax - floor_y >= 2.0)).sum())
        print(f"    edge distance {d} ({d * cell:.2f} m): {n:5d} cells, "
              f"{blocked:5d} in body band, {tall:5d} tall")

    print("\n  map:  digit = distance to floor edge, '.' = no floor")
    for row in range(nz - 1, -1, -1):
        line = []
        for col in range(nx):
            if not has_floor[row, col]:
                line.append(".")
            else:
                line.append(str(min(9, dist[row, col])))
        if row % 2 == 0:
            print(f"    z={min_z + row * cell:7.2f} |{''.join(line)}|")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyse(p)
