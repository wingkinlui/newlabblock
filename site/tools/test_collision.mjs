/* Verify the walkability grid: the camera must never leave the walkable
 * area, and walking in every direction must stay inside the room.
 *
 * Runs for all three rooms.
 */

import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8099';
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
await page.waitForSelector('.gate', { timeout: 8000 });
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

  // Install an in-page probe that samples the position every animation frame
  // and records any position that is not on a walkable cell.
  await page.evaluate(async () => {
    const res = await fetch('assets/collision/'
      + new URLSearchParams(location.search).get('model') + '.collision.json');
    const d = await res.json();
    window.__grid = d;

    // Decode the run-length encoded grid: each row is a flat
    // [value, count, value, count, ...] list.
    const cells = new Uint8Array(d.width * d.height);
    for (let gz = 0; gz < d.height; gz += 1) {
      let p = 0;
      const row = d.rle[gz];
      for (let i = 0; i < row.length; i += 2) {
        const value = row[i];
        const count = row[i + 1];
        for (let k = 0; k < count; k += 1) cells[gz * d.width + p++] = value;
      }
    }
    window.__cells = cells;

    window.__violations = [];
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
      if (value !== 2) {
        window.__violations.push({ x, z, value });
      }
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  });

  // Walk in all four directions for a while.
  const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
  for (const key of keys) {
    await page.keyboard.down(key);
    await new Promise((r) => setTimeout(r, 1400));
    await page.keyboard.up(key);
  }
  // And straight into a wall: walk forward for a long time.
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 4000));
  await page.keyboard.up('KeyW');
  await new Promise((r) => setTimeout(r, 300));

  const result = await page.evaluate(() => ({
    samples: window.__samples,
    violations: window.__violations.length,
    firstViolation: window.__violations[0] || null,
    pos: document.getElementById('position-readout').textContent,
    spawn: window.__grid.spawn,
    walkable: window.__grid.walkable,
    blocked: window.__grid.blocked,
  }));

  console.log(`  samples=${result.samples}  violations=${result.violations}`);
  console.log(`  final position: ${result.pos.trim()}  (spawn ${result.spawn.map((n) => n.toFixed(2)).join(', ')})`);
  console.log(`  grid: ${result.walkable} walkable / ${result.blocked} blocked cells`);
  if (result.firstViolation) {
    console.log(`  first violation: ${JSON.stringify(result.firstViolation)}`);
  }

  const moved = result.pos !== `${result.spawn[0].toFixed(2)}`;
  if (result.violations > 0) {
    console.log('  FAIL  camera left the walkable area');
    failures += 1;
  } else {
    console.log('  PASS  camera stayed on walkable floor');
  }
  if (result.samples < 20) {
    console.log('  FAIL  too few samples - the render loop may have stopped');
    failures += 1;
  } else {
    console.log(`  PASS  render loop ran (${result.samples} frames sampled)`);
  }
}

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nAll collision checks passed');
process.exit(failures ? 1 : 0);
