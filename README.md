# New Lab Block — private site tour

A small static website for the lab: the **5th floor plan**, the **site
snapshots**, and — the main event — **interactive 3D walkthroughs** of our
rooms captured with PolyCam.

The site is password protected and published with GitHub Pages.

| Page | What it shows |
| --- | --- |
| `index.html` | Overview: room cards, photo galleries, quick statistics |
| `3d.html` | First-person 3D viewer with WASD/mouse roaming and distance measuring |
| `floorplan.html` | The 5th floor plan (click to zoom) |
| `snapshots.html` | Photo gallery of the site visit |

## The 3D viewer

* **Move** with `W` `A` `S` `D` (or the arrow keys), hold `Shift` to run.
* **Look** with the mouse — drag to look, or double-click the canvas to lock
  the pointer for a proper first-person feel (`Esc` releases it again).
* **Measure** — press `M`, then click points on the model. Each segment and
  the total are shown in metres. Press `Esc` or `M` again to leave measure mode.
* **Reset** the view with `R`.
* The minimap in the corner shows the walkable floor, your position and the
  direction you are facing.

The PolyCam captures are in real-world scale (one unit = one metre), so the
measurements are actual distances.

### Collision

You cannot walk through walls or desks. This is driven by a walkability grid
that is generated from the capture geometry at build time (see below): every
cell of a 15 cm grid over the floor plan is marked as *void*, *blocked* or
*walkable*.

## Password protection

GitHub Pages is a static host with no server-side authentication, so the gate
runs in the browser:

1. `assets/js/auth-config.js` holds a **PBKDF2-HMAC-SHA256** hash of the
   password (150 000 iterations, random salt). The plaintext is never stored.
2. `assets/js/auth.js` shows the password form and derives the hash of what
   the visitor types to compare it with the stored one.
3. `sw.js` (a Service Worker) blocks direct requests for the models, photos
   and collision data until the site has been unlocked, so guessing an asset
   URL is not enough.

> **Note:** this is a strong deterrent, not a cryptographic guarantee. The
> site files themselves are still downloadable from the GitHub repository by
> anyone who can clone it. If the assets must stay truly private, keep the
> repository itself private and share access through a GitHub organisation, or
> host the site somewhere with real server-side auth (Cloudflare Access,
> Netlify password protection, or a small server with HTTP basic auth).

To change the password, regenerate the hash:

```bash
python tools/make_auth_config.py --password "new-password" --force
```

## Rebuilding the assets

The published site is built from the raw captures with a small Python/Node
pipeline. The source assets live in `FloorPlan/`, `SnapShots/` and `3DSpace/`
and are deliberately **not** committed (they are ~40 MB).

```bash
# 1. one-off: create the build environment
conda create -n labblock python=3.12 pillow numpy
conda activate labblock

# 2. build the 3D models (texture resize -> Draco compression -> collision grid)
python tools/build_models.py

# 3. build the images and the manifest
python tools/build_assets.py

# 4. regenerate the password hash (only needed when the password changes)
python tools/make_auth_config.py --password "..." --force
```

`tools/build_models.py` needs Node for the Draco step:

```bash
cd site && npm install three three-mesh-bvh gltf-pipeline && cd ..
```

### What the pipeline does

| Step | Effect |
| --- | --- |
| Texture resize | PolyCam embeds 4096 px JPEGs; they are downscaled to 2048 px |
| Draco compression | Geometry is compressed (`gltf-pipeline`) |
| Collision grid | A 15 cm walkability grid is derived from the geometry |
| Image resize | Photos are downscaled to 2560 px and stripped of EXIF (GPS!) |

Results:

| Capture | Original | Published |
| --- | --- | --- |
| Open Lab | 15.3 MB | 2.5 MB |
| Type C Lab | 7.5 MB | 0.9 MB |
| TF Office | 2.6 MB | 0.4 MB |
| 12 photos | ~40 MB | 6.1 MB |

## Local preview

```bash
cd site
python -m http.server 8099
# open http://127.0.0.1:8099
```

The Service Worker needs `http://localhost` or HTTPS, so use the server rather
than opening the files directly.

## Tests

```bash
cd site
node tools/test_site.mjs        # end-to-end: gate, pages, 3D viewer, measuring
node tools/test_collision.mjs   # the camera never leaves the walkable floor
```

## Credits

* [Three.js](https://threejs.org) — MIT licence, vendored under
  `assets/vendor/three/`.
* [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) — MIT licence.
* [gltf-pipeline](https://github.com/donmccurdy/gltf-pipeline) — Apache 2.0.
