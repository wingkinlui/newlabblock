/* Inspect the materials and lighting of a loaded model. */

import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'https://wingkinlui.github.io/newlabblock';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[error]', m.text().slice(0, 200));
});

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 15000 });
await page.type('#gate-password', 'tfcbioinform113');
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 25000 });

await page.goto(`${BASE}/3d.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loader.hidden', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 2000));

const info = await page.evaluate(() => {
  // Reach into the module scope via the canvas' three.js renderer is not
  // exposed, so walk the DOM-free way: find the scene through the WebGL
  // context is not possible.  Instead expose it for debugging.
  return window.__viewer ? 'exposed' : 'not exposed';
});
console.log('viewer exposure:', info);

// The viewer instance is not on window, so load the module directly and
// inspect a model file ourselves.
const report = await page.evaluate(async () => {
  const THREE = await import('./assets/vendor/three/three.module.min.js');
  const { GLTFLoader } = await import('./assets/vendor/three/GLTFLoader.js');
  const { DRACOLoader } = await import('./assets/vendor/three/DRACOLoader.js');
  const { loadDecryptedGLTF } = await import('./assets/js/crypto.js');

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('assets/vendor/draco/');
  loader.setDRACOLoader(draco);

  const gltf = await loadDecryptedGLTF(loader, 'assets/models/openlab.glb');
  const out = { meshes: [], materials: [], lights: [] };

  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    out.meshes.push({
      name: child.name || '(unnamed)',
      triangles: child.geometry.index
        ? child.geometry.index.count / 3
        : child.geometry.attributes.position.count / 3,
      hasUV: !!child.geometry.attributes.uv,
      materialCount: mats.length,
    });
    mats.forEach((m) => {
      out.materials.push({
        type: m.type,
        name: m.name || '',
        color: m.color ? m.color.getHexString() : null,
        map: !!m.map,
        mapImage: m.map?.image ? (m.map.image.width + 'x' + m.map.image.height) : null,
        mapColorSpace: m.map?.colorSpace ?? null,
        roughness: m.roughness,
        metalness: m.metalness,
        emissive: m.emissive ? m.emissive.getHexString() : null,
        side: m.side,
        transparent: m.transparent,
      });
    });
  });
  return out;
});

console.log(JSON.stringify(report, null, 2));

await browser.close();
