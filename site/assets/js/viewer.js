/* ==========================================================================
   First-person 3D viewer for the PolyCam captures.

   Features
     * WASD / arrow key walking with mouse look (pointer lock or drag)
     * collision against a pre-computed walkability grid, so you cannot walk
       through walls or desks
     * click to measure: pulls a polyline across the model and reports the
       distance of every segment and the total
     * a minimap showing where you are in the room

   The captures are in metres (PolyCam writes real-world scale), so every
   measurement is a real distance.
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/DRACOLoader.js';
import { Line2 } from 'three/addons/Line2.js';
import { LineGeometry } from 'three/addons/LineGeometry.js';
import { LineMaterial } from 'three/addons/LineMaterial.js';
import { MeshBVH } from 'three-mesh-bvh';
import { loadDecryptedGLTF, loadDecryptedJSON } from './crypto.js';

const EYE_HEIGHT = 1.62;
const WALK_SPEED = 2.4;
const RUN_SPEED = 5.0;
const RADIUS = 0.40;          // player collision radius in metres

// Cell values of the walkability grid produced by tools/build_collision.py.
const VOID = 0;               // no geometry - outside the capture
const BLOCKED = 1;            // wall, desk or other obstacle
const WALKABLE = 2;           // open floor

/* --------------------------------------------------------------- helpers */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Decode the run-length encoded collision grid into a Uint8Array. */
function decodeGrid(collision) {
  const w = collision.width;
  const h = collision.height;
  const cells = new Uint8Array(w * h);
  let p = 0;
  for (let row = 0; row < h; row += 1) {
    const pairs = collision.rle[row];
    for (let i = 0; i < pairs.length; i += 2) {
      const value = pairs[i];
      const count = pairs[i + 1];
      for (let k = 0; k < count && p < cells.length; k += 1) {
        cells[p] = value;
        p += 1;
      }
    }
  }
  return cells;
}

/* ---------------------------------------------------------------- viewer */

export class LabViewer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.onStatus = options.onStatus || (() => {});
    this.onMeasureUpdate = options.onMeasureUpdate || (() => {});
    this.onCameraMove = options.onCameraMove || (() => {});

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f14);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.02, 120);

    // Lighting: the captures carry their own textures, so a soft ambient
    // light plus a directional light is enough to read the geometry.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.55));
    const hemi = new THREE.HemisphereLight(0xdfefff, 0x50555c, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.35);
    sun.position.set(4, 9, 6);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xcfe6ff, 0.45);
    fill.position.set(-6, 4, -5);
    this.scene.add(fill);

    this.yaw = 0;
    this.pitch = 0;
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.position = new THREE.Vector3();
    this.floorY = 0;
    this.collision = null;
    this.measureMode = false;
    this.measurePoints = [];
    this.measureLines = [];
    this.measureLabels = [];
    this.clock = new THREE.Clock();
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };

    this.setupControls();
    this.resize();
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Fat lines need their resolution updated when the canvas changes size.
    for (const obj of this.measureLines) {
      if (obj.material && obj.material.isLineMaterial) {
        obj.material.resolution.set(width, height);
      }
    }
  }


  /* --------------------------------------------------------------- input */

  setupControls() {
    const canvas = this.canvas;

    window.addEventListener('resize', () => this.resize());

    canvas.addEventListener('click', (e) => {
      if (this.measureMode) this.handleMeasureClick(e);
    });

    // Mouse look: pointer lock on click, plus drag-to-look as a fallback
    // (pointer lock can be blocked in embedded frames).
    canvas.addEventListener('mousedown', (e) => {
      if (this.measureMode) return;
      this.dragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (this.measureMode) return;
      if (document.pointerLockElement === canvas) {
        this.look(e.movementX, e.movementY);
      } else if (this.dragging) {
        this.look(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y);
        this.lastPointer = { x: e.clientX, y: e.clientY };
      }
    });

    // Double click to enter pointer lock (full "game" style control).
    canvas.addEventListener('dblclick', () => {
      if (this.measureMode) return;
      canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.onStatus(document.pointerLockElement === canvas
        ? 'Pointer locked - press Esc to release the mouse'
        : '');
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'KeyM') this.toggleMeasure();
      if (e.code === 'KeyR') this.resetView();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  look(dx, dy) {
    const sensitivity = 0.0022;
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch - dy * sensitivity, -1.45, 1.45);
  }

  toggleMeasure() {
    this.measureMode = !this.measureMode;
    if (this.measureMode) {
      this.clearMeasurement();
      this.onStatus('Measure mode - click points on the model, Esc cancels');
    } else {
      this.onStatus('');
    }
    return this.measureMode;
  }

  /* -------------------------------------------------------------- loading */

  async load(modelInfo, collisionUrl) {
    this.onStatus('Loading 3D model...');

    // --- collision / walkability grid -----------------------------------
    // The grid is stored encrypted; it is decrypted with the key derived
    // from the site password.
    this.collision = null;
    if (collisionUrl) {
      const data = await loadDecryptedJSON(collisionUrl);
      this.collision = { ...data, cells: decodeGrid(data) };
    }

    // --- model ------------------------------------------------------------
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('assets/vendor/draco/');
    loader.setDRACOLoader(draco);

    const gltf = await loadDecryptedGLTF(loader, modelInfo.file);
    this.model = gltf.scene;

    // Build a BVH per mesh so picking (and measurement) stays fast.
    this.pickables = [];
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      child.frustumCulled = false;
      child.geometry.computeBoundingBox();
      try {
        child.geometry.boundsTree = new MeshBVH(child.geometry, { maxLeafTris: 10 });
      } catch (err) {
        console.warn('BVH build failed', err);
      }
      this.pickables.push(child);
    });

    this.scene.add(this.model);

    // --- camera start ------------------------------------------------------
    const spawn = this.collision?.spawn || modelInfo.spawn || [0, EYE_HEIGHT, 0];
    const heading = this.collision?.heading ?? modelInfo.heading ?? 0;
    this.position.set(spawn[0], spawn[1], spawn[2]);
    this.yaw = THREE.MathUtils.degToRad(heading);
    this.pitch = 0;
    this.floorY = this.collision?.floorY ?? modelInfo.floorY ?? 0;
    this.updateCamera();

    this.onStatus('');
    return this.model;
  }

  /* ------------------------------------------------------------ movement */

  /** Is the given world XZ position free to stand on? */
  isWalkable(x, z) {
    if (!this.collision) return true;
    const { cell, origin, width, height, cells } = this.collision;
    const gx = Math.floor((x - origin[0]) / cell);
    const gz = Math.floor((z - origin[1]) / cell);
    if (gx < 0 || gx >= width || gz < 0 || gz >= height) return false;
    return cells[gz * width + gx] === WALKABLE;
  }

  /**
   * Can the player move from the current position to (x, z)?
   *
   * The player is a circle of radius RADIUS, so we test the centre cell plus
   * the cells just outside it; if any of those are blocked the move is
   * rejected.  This keeps the camera from clipping into walls.
   */
  canMove(x, z) {
    if (!this.collision) return true;
    if (!this.isWalkable(x, z)) return false;
    const { cell } = this.collision;
    const checks = [
      [RADIUS, 0], [-RADIUS, 0], [0, RADIUS], [0, -RADIUS],
      [RADIUS * 0.7, RADIUS * 0.7], [-RADIUS * 0.7, RADIUS * 0.7],
      [RADIUS * 0.7, -RADIUS * 0.7], [-RADIUS * 0.7, -RADIUS * 0.7],
    ];
    for (const [dx, dz] of checks) {
      if (!this.isWalkable(x + dx, z + dz)) return false;
    }
    return true;
  }

  /** Slide the player along walls instead of stopping dead. */
  moveWithCollision(dx, dz) {
    if (this.canMove(this.position.x + dx, this.position.z + dz)) {
      this.position.x += dx;
      this.position.z += dz;
      return;
    }
    // Try each axis on its own so the player slides along the wall.
    if (this.canMove(this.position.x + dx, this.position.z)) {
      this.position.x += dx;
    }
    if (this.canMove(this.position.x, this.position.z + dz)) {
      this.position.z += dz;
    }
  }

  updateCamera() {
    this.camera.position.copy(this.position);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.onCameraMove(this.position, this.yaw);
  }

  /** Main animation loop step. */
  update() {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    const forward = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0)
      - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0)
      - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    if (forward || strafe) {
      const speed = running ? RUN_SPEED : WALK_SPEED;
      // Movement happens in the direction the camera looks (horizontal only).
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const moveX = (-sin * forward + cos * strafe) * speed * dt;
      const moveZ = (-cos * forward - sin * strafe) * speed * dt;
      this.moveWithCollision(moveX, moveZ);
    }

    // Keep the camera at eye height above the floor.
    this.position.y = this.floorY + EYE_HEIGHT;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  start() {
    const loop = () => {
      this.frameId = requestAnimationFrame(loop);
      this.update();
    };
    loop();
  }

  stop() {
    if (this.frameId) cancelAnimationFrame(this.frameId);
  }

  /* ---------------------------------------------------------- measurement */

  /** Raycast from the mouse into the model and return the world hit point. */
  pick(event) {
    if (!this.pickables?.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    raycaster.far = 200;

    const hits = raycaster.intersectObjects(this.pickables, false);
    if (!hits.length) return null;
    return hits[0].point.clone();
  }

  handleMeasureClick(event) {
    const point = this.pick(event);
    if (!point) return;

    this.measurePoints.push(point);
    this.addMarker(point);

    if (this.measurePoints.length > 1) {
      const from = this.measurePoints[this.measurePoints.length - 2];
      this.addSegment(from, point);
    }
    this.updateMeasurementReadout();
  }

  addMarker(point) {
    const geometry = new THREE.SphereGeometry(0.055, 16, 12);
    const material = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(point);
    this.scene.add(marker);
    this.measureLines.push(marker);
  }

  addSegment(from, to) {
    const distance = from.distanceTo(to);

    const geometry = new LineGeometry();
    geometry.setPositions([from.x, from.y, from.z, to.x, to.y, to.z]);
    const material = new LineMaterial({
      color: 0xfbbf24,
      linewidth: 3,
      dashed: false,
      depthTest: false,
      transparent: true,
    });
    material.resolution.set(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 10;
    this.scene.add(line);
    this.measureLines.push(line);

    // Small sphere at the midpoint so the segment reads clearly.
    const mid = from.clone().lerp(to, 0.5);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff3c4 }),
    );
    dot.position.copy(mid);
    this.scene.add(dot);
    this.measureLines.push(dot);
  }

  /** Send the current segment/total distances to the page. */
  updateMeasurementReadout() {
    const segments = [];
    let total = 0;
    for (let i = 1; i < this.measurePoints.length; i += 1) {
      const d = this.measurePoints[i - 1].distanceTo(this.measurePoints[i]);
      segments.push(d);
      total += d;
    }
    this.onMeasureUpdate({ segments, total, points: this.measurePoints.length });
  }

  clearMeasurement() {
    for (const obj of this.measureLines) {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    }
    this.measureLines = [];
    this.measurePoints = [];
    this.updateMeasurementReadout();
  }

  resetView() {
    if (!this.collision) return;
    const spawn = this.collision.spawn;
    this.position.set(spawn[0], spawn[1], spawn[2]);
    this.yaw = THREE.MathUtils.degToRad(this.collision.heading);
    this.pitch = 0;
    this.updateCamera();
  }
}