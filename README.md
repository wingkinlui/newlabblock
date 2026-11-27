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

GitHub Pages is a static host with no server-side authentication, so the
protection is built into the files themselves:

1. **The assets are encrypted.** The 3D models, the photos and the collision
   grids are stored as **AES-256-GCM ciphertext**. The key is derived from the
   password with PBKDF2-HMAC-SHA256 (600 000 iterations). Someone who
   downloads the files from the repository gets unreadable data — there is no
   readable GLB, JPEG or JSON in the published site.
2. **The password itself is never stored.** `assets/js/auth-config.js` holds a
   separate PBKDF2-HMAC-SHA256 hash (150 000 iterations) of the password.
   `assets/js/auth.js` derives the hash of what the visitor types and
   compares it.
3. **The browser decrypts on the fly.** `assets/js/crypto.js` derives the
   AES key after a successful unlock and decrypts each file in memory. The
   model is handed to Three.js as a blob URL; photos become object URLs.
4. **The key is kept safely.** The derived `CryptoKey` is stored in IndexedDB
   as a *non-extractable* key, so a reload does not ask for the password
   again while the raw key material never leaves the browser.
5. **The gate covers the pages too.** The HTML/CSS/JS is served normally
   (it has to be, so the browser can show the password form), but every page
   is blank until the password is accepted.

> **What this does and does not achieve:** the models and photos cannot be
> extracted from the published site without the password, and the page content
> is hidden until someone enters it. The remaining exposure is that the
> *page code* itself is public — an attacker can see how the gate works.
> That is inherent to a static host. If you need stronger guarantees, keep
> the repository private as well (GitHub free accounts support private
> repositories with Pages), or host the site somewhere with real server-side
> authentication such as Cloudflare Access or Netlify password protection.

### Changing the password

Both the verification hash and the encryption key are derived from the
password, so they have to be regenerated together — and the assets have to be
re-encrypted:

```bash
# 1. new verification hash
python tools/make_auth_config.py --password "new-password" --force

# 2. restore the plaintext assets and re-encrypt them
#    (rebuild them with tools/build_models.py + tools/build_assets.py,
#     or restore from work/plaintext_assets/)
python tools/encrypt_assets.py --password "new-password" --decrypt-check
```

## Rebuilding the assets

The published site is built from the raw captures with a small Python/Node
pipeline. The source assets live in `FloorPlan/`, `SnapShots/` and `3DSpace/`
and are deliberately **not** committed (they are ~40 MB).

```bash
# 1. one-off: create the build environment
conda create -n labblock python=3.12 pillow numpy cryptography
conda activate labblock

# 2. build the 3D models (texture resize -> Draco compression -> collision grid)
python tools/build_models.py

# 3. build the images and the manifest
python tools/build_assets.py

# 4. encrypt the assets with the site password
python tools/encrypt_assets.py --password "..." --decrypt-check

# 5. regenerate the password hash (only needed when the password changes)
python tools/make_auth_config.py --password "..." --force
```

`tools/build_models.py` needs Node for the Draco step:

```bash
cd site && npm install && cd ..
```

> The build order matters: `build_assets.py` and `build_models.py` write the
> **plaintext** assets, and `encrypt_assets.py` then encrypts them in place.
> Re-running the build scripts therefore un-encrypts the files, and
> `encrypt_assets.py` must always be the last step.

### What the pipeline does

| Step | Effect |
| --- | --- |
| Texture resize | PolyCam embeds 4096 px JPEGs; they are downscaled to 2048 px |
| Draco compression | Geometry is compressed (`gltf-pipeline`) |
| Collision grid | A 15 cm walkability grid is derived from the geometry |
| Image resize | Photos are downscaled to 2560 px and stripped of EXIF (GPS!) |
| Encryption | Models, photos and grids are encrypted with AES-256-GCM |

Results:

| Capture | Original | Published (compressed) | Published (encrypted) |
| --- | --- | --- | --- |
| Open Lab | 15.3 MB | 2.5 MB | 2.5 MB |
| Type C Lab | 7.5 MB | 0.9 MB | 0.9 MB |
| TF Office | 2.6 MB | 0.4 MB | 0.4 MB |
| 12 photos | ~40 MB | 6.1 MB | 6.1 MB |

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
node tools/test_site.mjs          # end-to-end: gate, pages, 3D viewer, measuring
node tools/test_collision.mjs     # the camera never leaves the walkable floor
node tools/test_visitor_journey.mjs  # a fresh visitor: encrypted files, unlock, browse
```

## Credits

* [Three.js](https://threejs.org) — MIT licence, vendored under
  `assets/vendor/three/`.
* [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) — MIT licence.
* [gltf-pipeline](https://github.com/donmccurdy/gltf-pipeline) — Apache 2.0.
