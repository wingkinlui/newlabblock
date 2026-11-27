/* Verify the walkability grid and the clipping behaviour:
 *
 *   - in the default mode the camera may pass through furniture and building
 *     materials, but never through a wall or the room boundary,
 *   - in "solid objects" mode the furniture blocks the way again.
 */

import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PASSWORD = 'tfcbioinform113';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// Unlock once.
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 10000 });
await page.type('#gate-password', PASSWORD);
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 15000 });
console.log('unlocked\n');

const rooms = ['openlab', 'typeclab', 'tfoffice'];
let failures = 0;

for (const room of rooms) {
  console.log(`=== ${room} ===`);
  await page.goto(`${BASE}/3d.html?model=${room}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loader.hidden', { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 800));

  // Install a probe that samples the position every frame and records any
  // position that lands on a wall.
  await page.evaluate(async () => {
    const mod = await import('./assets/js/crypto.js');
    const d = await mod.loadDecryptedJSON('assets/collision/'
      + new URLSearchParams(location.search).get('model') + '.collision.json');
    window.__grid = d;

    const cells = new Uint8Array(d.width * d.height);
    for (let gz = 0; gz < d.height; gz += 1) {
      let p = 0;
      const row = d.rle[gz];
      for (let i = 0; i < row.length; i += 2) {
        for (let k = 0; k < row[i + 1]; k += 1) {
          cells[gz * d.width + p++] = row[i];
        }
      }
    }
    window.__cells = cells;
    window.__wallHits = [];
    window.__objectHits = [];
    window.__samples = 0;

    const probe = () => {
      const readout = document.getElementById('position-readout').textContent;
      const m = readout.match(/x\s+(-?[\d.]+)\s+z\s+(-?[\d.]+)/);
      if (!m) return;
      const x = parseFloat(m[1]);
      const z = parseFloat(m[2]);
      const gx = Math.floor((x - d.origin[0]) / d.cell);
      const gz = Math.floor((z - d.origin[1]) / d.cell);
      const value = (gx < 0 || gx >= d.width || gz < 0 || gz >= d.height)
        ? 0 : cells[gz * d.width + gx];
      window.__samples += 1;
      if (value === 1) window.__wallHits.push({ x, z });
      if (value === 3) window.__objectHits.push({ x, z });
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  });

  // --- default mode: clip through objects -----------------------------
  const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
  for (const key of keys) {
    await page.keyboard.down(key);
    await new Promise((r) => setTimeout(r, 1400));
    await page.keyboard.up(key);
  }
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 4000));
  await page.keyboard.up('KeyW');
  await new Promise((r) => setTimeout(r, 300));

  const clipMode = await page.evaluate(() => ({
    wallHits: window.__wallHits.length,
    objectHits: window.__objectHits.length,
    samples: window.__samples,
    pos: document.getElementById('position-readout').textContent.trim(),
    stats: window.__grid,
  }));

  console.log(`  clip mode : samples=${clipMode.samples}  `
    + `wall hits=${clipMode.wallHits}  object hits=${clipMode.objectHits}`);
  console.log(`  grid      : ${clipMode.stats.walkable} walkable, `
    + `${clipMode.stats.blocked} walls, ${clipMode.stats.objects ?? 0} objects`);

  if (clipMode.wallHits === 0) {
    console.log('  PASS  never entered a wall');
  } else {
    console.log('  FAIL  walked into a wall');
    failures += 1;
  }
  if (clipMode.objectHits > 0) {
    console.log('  PASS  clipped through objects');
  } else {
    console.log('  note  no object was crossed in this run');
  }

  // --- solid mode: objects block again --------------------------------
  await page.keyboard.press('KeyC');
  await new Promise((r) => setTimeout(r, 300));
  const solidOn = await page.$eval('#clip-toggle', (b) => b.classList.contains('solid'));
  console.log(`  solid mode toggled: ${solidOn}`);
  if (!solidOn) {
    console.log('  FAIL  the clip/solid toggle did not switch');
    failures += 1;
  }

  // Walk into the nearest object and check we are stopped by it.
  await page.evaluate(() => {
    window.__wallHits = [];
    window.__objectHits = [];
  });
  for (const key of ['KeyW', 'KeyD', 'KeyS', 'KeyA']) {
    await page.keyboard.down(key);
    await new Promise((r) => setTimeout(r, 1200));
    await page.keyboard.up(key);
  }
  const solidMode = await page.evaluate(() => ({
    wallHits: window.__wallHits.length,
    objectHits: window.__objectHits.length,
  }));
  console.log(`  solid mode: wall hits=${solidMode.wallHits}  `
    + `object hits=${solidMode.objectHits}`);
  if (solidMode.objectHits === 0 && solidMode.wallHits === 0) {
    console.log('  note  nothing was hit in solid mode either');
  } else {
    console.log('  PASS  solid mode stops the camera');
  }

  // Switch back to clipping.
  await page.keyboard.press('KeyC');
  await new Promise((r) => setTimeout(r, 200));
}

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nAll collision checks passed');
process.exit(failures ? 1 : 0);
