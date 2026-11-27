"""Inspect a .glb file without third-party dependencies.

Reports node hierarchy, mesh/triangle counts, material & texture usage, and the
world-space bounding box of all POSITION accessors (used to work out the real
world scale of a PolyCam capture so the viewer can use metre units).
"""

import json
import struct
import sys
from pathlib import Path

GLB_MAGIC = 0x46546C67  # 'glTF'
CHUNK_JSON = 0x4E4F534A  # 'JSON'
CHUNK_BIN = 0x004E4942  # 'BIN\0'


def read_glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path} is not a binary glTF (magic={magic:#x})")

    gltf = None
    binary = None
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
    return version, gltf, binary


def accessor_bounds(gltf, index):
    acc = gltf["accessors"][index]
    if "min" not in acc or "max" not in acc:
        return None
    return acc["min"], acc["max"]


def main():
    for raw in sys.argv[1:]:
        path = Path(raw)
        version, gltf, binary = read_glb(path)
        print("=" * 78)
        print(f"{path}")
        print(f"  glTF version {version} | generator={gltf.get('asset', {}).get('generator')}")
        print(f"  binary chunk: {(len(binary) / 1024 / 1024):.2f} MB" if binary else "  no binary chunk")

        scenes = gltf.get("scenes", [])
        scene = scenes[gltf.get("scene", 0)] if scenes else {"nodes": []}
        nodes = gltf.get("nodes", [])
        print(f"  scenes={len(scenes)} nodes={len(nodes)} meshes={len(gltf.get('meshes', []))} "
              f"materials={len(gltf.get('materials', []))} textures={len(gltf.get('textures', []))} "
              f"images={len(gltf.get('images', []))}")

        tri_total = 0
        for mesh in gltf.get("meshes", []):
            for prim in mesh.get("primitives", []):
                mode = prim.get("mode", 4)
                if mode != 4:  # only triangles carry vertex counts
                    continue
                idx = prim.get("indices")
                if idx is not None:
                    count = gltf["accessors"][idx]["count"]
                    tri_total += count // 3
                else:
                    count = gltf["accessors"][prim["attributes"]["POSITION"]]["count"]
                    tri_total += count // 3

        # world bounds from every POSITION accessor min/max (local space is enough
        # for a capture that is authored with identity transforms)
        lo = [float("inf")] * 3
        hi = [float("-inf")] * 3
        seen = 0
        for mesh in gltf.get("meshes", []):
            for prim in mesh.get("primitives", []):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None:
                    continue
                bounds = accessor_bounds(gltf, pos)
                if not bounds:
                    continue
                seen += 1
                for i in range(3):
                    lo[i] = min(lo[i], bounds[0][i])
                    hi[i] = max(hi[i], bounds[1][i])
        if seen:
            size = [hi[i] - lo[i] for i in range(3)]
            print(f"  triangles={tri_total:,}  position accessors={seen}")
            print(f"  bbox min = [{', '.join(f'{v:.3f}' for v in lo)}]")
            print(f"  bbox max = [{', '.join(f'{v:.3f}' for v in hi)}]")
            print(f"  size (x,y,z) = [{', '.join(f'{v:.3f}' for v in size)}]")
            print(f"  -> if 1 unit == 1 m, floor area is about {size[0]:.1f} m x {size[2]:.1f} m, "
                  f"wall height {size[1]:.1f} m")
        else:
            print("  no POSITION accessors found")

        print("  node hierarchy (first 25):")
        for i, node in enumerate(nodes[:25]):
            label = node.get("name", f"node_{i}")
            extras = {k: v for k, v in node.items()
                      if k in ("mesh", "children", "translation", "rotation", "scale")}
            print(f"    - {label}: {extras}")
        if len(nodes) > 25:
            print(f"    ... and {len(nodes) - 25} more nodes")

        for i, mat in enumerate(gltf.get("materials", [])):
            pbr = mat.get("pbrMetallicRoughness", {})
            base = pbr.get("baseColorTexture")
            print(f"  material[{i}] {mat.get('name', '')!r} baseTexture={base} "
                  f"alphaMode={mat.get('alphaMode', 'OPAQUE')}")


if __name__ == "__main__":
    main()
