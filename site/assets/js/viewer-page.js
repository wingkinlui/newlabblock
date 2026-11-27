/* Page controller for 3d.html: wires the LabViewer to the DOM. */

import { requireAuth, initLockButton, initUpdateNotice } from './auth.js';
await requireAuth();
initLockButton();
initUpdateNotice();

import { loadManifest, formatBytes, formatMetres } from './common.js';
import { LabViewer } from './viewer.js';

const manifest = await loadManifest();
const params = new URLSearchParams(location.search);
const requested = params.get('model');
const models = manifest.models;
let current = models.find((m) => m.id === requested) || models[0];

/* --------------------------------------------------------- model switcher */

const buttons = document.getElementById('model-buttons');
models.forEach((model) => {
  const button = document.createElement('button');
  button.className = 'model-btn';
  button.textContent = model.title;
  button.dataset.id = model.id;
  button.addEventListener('click', () => switchModel(model.id));
  buttons.appendChild(button);
});

function markActive(id) {
  buttons.querySelectorAll('.model-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.id === id);
  });
}

/* ------------------------------------------------------------------ info */

function renderInfo(model) {
  document.getElementById('info-title').textContent = model.title;
  document.getElementById('info-subtitle').textContent = model.subtitle || '';
  const size = model.roomSize || model.bounds?.size || [0, 0, 0];
  const rows = [
    ['Room size', `${formatMetres(size[0])} &times; ${formatMetres(size[2])}`],
    ['Walkable area', model.floorArea ? `${model.floorArea} m&sup2;` : '-'],
    ['Clippable objects', model.objectArea ? `${model.objectArea} m&sup2;` : '-'],
    ['Ceiling height', model.ceilingY != null
      ? formatMetres(model.ceilingY - model.floorY) : '-'],
    ['Triangles', model.triangles ? model.triangles.toLocaleString() : '-'],
    ['Download', formatBytes(model.bytes)],
    ['Capture file', model.sourceName],
  ];
  document.querySelector('#info-table tbody').innerHTML = rows
    .map(([k, v]) => `<tr><th>${k}</th><td class="num">${v}</td></tr>`)
    .join('');
}

/* ---------------------------------------------------------------- viewer */

const canvas = document.getElementById('viewer-canvas');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');
const statusEl = document.getElementById('hud-status');
const positionEl = document.getElementById('position-readout');
const measurePanel = document.getElementById('measure-panel');
const measureReadout = document.getElementById('measure-readout');

const viewer = new LabViewer(canvas, {
  onStatus: (text) => { statusEl.textContent = text; },
  onCameraMove: (position) => {
    positionEl.textContent = `x ${position.x.toFixed(2)}  z ${position.z.toFixed(2)} m`;
    drawMinimap();
  },
  onMeasureUpdate: ({ segments, total, points }) => {
    measurePanel.hidden = false;
    if (!points) {
      measureReadout.textContent = 'Click points on the model to measure.';
      return;
    }
    const parts = segments.map((d, i) =>
      `<div>${i + 1}. ${d.toFixed(3)} m</div>`).join('');
    measureReadout.innerHTML = parts +
      (segments.length
        ? `<div class="measure-total">Total: ${total.toFixed(3)} m</div>`
        : '');
  },
});

/* --------------------------------------------------------------- minimap */

const minimap = document.getElementById('minimap');
const mctx = minimap.getContext('2d');

function drawMinimap() {
  const collision = viewer.collision;
  if (!collision) return;
  const { cell, origin, width, height, cells } = collision;

  const scale = Math.min(minimap.width / width, minimap.height / height);
  const offX = (minimap.width - width * scale) / 2;
  const offY = (minimap.height - height * scale) / 2;

  mctx.clearRect(0, 0, minimap.width, minimap.height);
  mctx.fillStyle = '#0d131b';
  mctx.fillRect(0, 0, minimap.width, minimap.height);

  for (let gz = 0; gz < height; gz += 1) {
    for (let gx = 0; gx < width; gx += 1) {
      const v = cells[gz * width + gx];
      if (v === 0) continue;
      // 1 = wall, 2 = open floor, 3 = object.
      if (v === 1) mctx.fillStyle = '#3a4a5e';
      else if (v === 2) mctx.fillStyle = '#1f6f8b';
      else mctx.fillStyle = viewer.solidObjects ? '#7c5c1e' : '#2a3a48';
      mctx.fillRect(offX + gx * scale,
        offY + (height - 1 - gz) * scale, scale, scale);
    }
  }

  // Player marker with a view cone.
  const px = offX + ((viewer.position.x - origin[0]) / cell) * scale;
  const pz = offY + (height - 1 - ((viewer.position.z - origin[1]) / cell)) * scale;
  const dir = viewer.yaw + Math.PI;
  mctx.save();
  mctx.translate(px, pz);
  mctx.rotate(-dir);
  mctx.fillStyle = 'rgba(56,189,248,0.35)';
  mctx.beginPath();
  mctx.moveTo(0, 0);
  mctx.arc(0, 0, 26, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
  mctx.closePath();
  mctx.fill();
  mctx.restore();

  mctx.fillStyle = '#38bdf8';
  mctx.beginPath();
  mctx.arc(px, pz, 4, 0, Math.PI * 2);
  mctx.fill();

  viewer.measurePoints.forEach((p) => {
    const mx = offX + ((p.x - origin[0]) / cell) * scale;
    const mz = offY + (height - 1 - ((p.z - origin[1]) / cell)) * scale;
    mctx.fillStyle = '#fbbf24';
    mctx.beginPath();
    mctx.arc(mx, mz, 3, 0, Math.PI * 2);
    mctx.fill();
  });
}


/* -------------------------------------------------------------- switching */

async function switchModel(id) {
  const model = models.find((m) => m.id === id);
  if (!model) return;
  current = model;

  markActive(id);
  loader.classList.remove('hidden');
  loaderText.textContent = `Loading ${model.title}...`;
  measurePanel.hidden = true;
  measureReadout.textContent = 'Click points on the model to measure.';

  if (viewer.model) {
    viewer.scene.remove(viewer.model);
    viewer.model = null;
    viewer.pickables = [];
    viewer.clearMeasurement();
  }

  renderInfo(model);
  try {
    await viewer.load(model, model.collision);
    loader.classList.add('hidden');
    history.replaceState({}, '', `3d.html?model=${encodeURIComponent(id)}`);
  } catch (err) {
    loaderText.textContent = `Could not load ${model.title}: ${err.message}`;
    console.error(err);
  }
}

/* -------------------------------------------------------------- UI wiring */

document.getElementById('measure-clear').addEventListener('click', () => {
  viewer.clearMeasurement();
});

// Clip / solid objects toggle.
const clipToggle = document.getElementById('clip-toggle');
const clipState = document.getElementById('clip-state');

function renderClipState() {
  const solid = viewer.solidObjects;
  clipToggle.setAttribute('aria-pressed', String(solid));
  clipToggle.classList.toggle('solid', solid);
  clipState.textContent = solid
    ? 'Solid objects (furniture blocks)'
    : 'Clipping through objects';
}

clipToggle.addEventListener('click', () => {
  viewer.toggleSolidObjects();
  renderClipState();
});

const infoPanel = document.getElementById('info-panel');
document.getElementById('info-toggle').addEventListener('click', () => {
  infoPanel.classList.toggle('open');
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewer.measureMode) {
    viewer.toggleMeasure();
    measurePanel.hidden = true;
  }
  if (e.code === 'KeyC') renderClipState();
});

/* --------------------------------------------------------------- start up */

markActive(current.id);
renderInfo(current);
renderClipState();
await switchModel(current.id);
viewer.start();
