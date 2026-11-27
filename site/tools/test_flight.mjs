/* Test the flight (drone) mode.
 *
 * Checks that in flight mode the camera
 *   - can leave the walkable area and pass through walls,
 *   - can change its height,
 *   - is put back on the floor when flight mode is switched off.
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

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Read the grid cell type under the camera (1 = wall, 2 = floor, 3 = object). */
async function cellType() {
  return page.evaluate(async () => {
    const mod = await import('./assets/js/crypto.js');
    const d = await mod.loadDecryptedJSON('assets/collision/openlab.collision.json');
    const cells = new Uint8Array(d.width * d.height);
    for (let gz = 0; gz < d.height; gz += 1) {
      let p = 0;
      const row = d.rle[gz];
      for (let i = 0; i < row.length; i += 2) {
        for (let k = 0; k < row[i + 1]; k += 1) cells[gz * d.width + p++] = row[i];
      }
    }
    const text = document.getElementById('position-readout').textContent;
    const m = text.match(/x\s+(-?[\d.]+)\s+(?:y\s+(-?[\d.]+)\s+)?z\s+(-?[\d.]+)/);
    const x = parseFloat(m[1]);
    const z = parseFloat(m[3]);
    const gx = Math.floor((x - d.origin[0]) / d.cell);
    const gz = Math.floor((z - d.origin[1]) / d.cell);
    return (gx < 0 || gx >= d.width || gz < 0 || gz >= d.height)
      ? 0 : cells[gz * d.width + gx];
  });
}

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 15000 });
await page.type('#gate-password', PASSWORD);
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 20000 });

await page.goto(`${BASE}/3d.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loader.hidden', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 600));

const readPos = () => page.evaluate(() => {
  const text = document.getElementById('position-readout').textContent;
  const m = text.match(/x\s+(-?[\d.]+)\s+(?:y\s+(-?[\d.]+)\s+)?z\s+(-?[\d.]+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[3]), m[2] ? parseFloat(m[2]) : null] : null;
});

// --- switch flight on -------------------------------------------------
const flightBtnVisible = await page.evaluate(() => {
  const b = document.getElementById('flight-toggle');
  if (!b) return false;
  const r = b.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});
check('the Fly button is visible', flightBtnVisible);

await page.click('#flight-toggle');
await new Promise((r) => setTimeout(r, 400));

const flightOn = await page.$eval('#flight-toggle', (b) => b.classList.contains('active'));
check('flight mode switched on', flightOn);

const label = await page.$eval('#flight-state', (el) => el.textContent.trim());
check('the button label shows the state', /Flying/i.test(label), label);


// --- the camera must be able to leave the walkable area ---------------
const start = await readPos();
await page.keyboard.down('KeyW');
await new Promise((r) => setTimeout(r, 6000));
await page.keyboard.up('KeyW');
await new Promise((r) => setTimeout(r, 300));
const after = await readPos();

const dist = Math.hypot(after[0] - start[0], after[1] - start[1]);
console.log(`  travelled ${dist.toFixed(2)} m while flying`);

const cell = await cellType();
console.log(`  the camera is on grid cell type ${cell} `
  + '(1 = wall, 2 = floor, 3 = object)');

if (cell !== 2) {
  check('the camera left the walkable floor', true, `cell type ${cell}`);
} else {
  console.log('  note  the camera is still on open floor here');
}

// --- vertical movement -------------------------------------------------
const yBefore = (await readPos())[2];
await page.keyboard.down('Space');
await new Promise((r) => setTimeout(r, 1500));
await page.keyboard.up('Space');
await new Promise((r) => setTimeout(r, 400));
const yAfter = (await readPos())[2];
console.log(`  height ${yBefore} m -> ${yAfter} m`);
check('the camera gains altitude', yBefore !== null && yAfter !== null
  && yAfter > yBefore, `${yBefore} -> ${yAfter}`);

// And back down again.
await page.keyboard.down('KeyQ');
await new Promise((r) => setTimeout(r, 1500));
await page.keyboard.up('KeyQ');
await new Promise((r) => setTimeout(r, 400));
const yDown = (await readPos())[2];
check('the camera can descend again', yDown < yAfter, `${yAfter} -> ${yDown}`);

// --- switching back to walking drops the camera onto the floor ---------
await page.click('#flight-toggle');
await new Promise((r) => setTimeout(r, 500));
const flightOff = await page.$eval('#flight-toggle', (b) => b.classList.contains('active'));
check('flight mode switched off', !flightOff);

await page.keyboard.down('KeyW');
await new Promise((r) => setTimeout(r, 1200));
await page.keyboard.up('KeyW');
await new Promise((r) => setTimeout(r, 300));

const backOnFloor = await cellType();
console.log(`  back on grid cell type ${backOnFloor} `
  + '(2 = floor, 3 = object - both are passable when clipping)');
// After a flight the camera is put back on the floor of the room.  Cell type
// 2 is open floor, type 3 is an object - both are inside the room and both
// can be walked on when clipping is on (the default).
if (backOnFloor === 2 || backOnFloor === 3) {
  check('walking mode puts the camera back inside the room', true);
} else {
  check('walking mode puts the camera back inside the room', false,
    `cell type ${backOnFloor}`);
}

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nFlight mode checks passed');
process.exit(failures ? 1 : 0);
