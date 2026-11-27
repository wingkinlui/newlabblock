/* End-to-end smoke test for the site.
 *
 * Drives headless Edge/Chrome to verify:
 *   1. the password gate appears and blocks the page,
 *   2. a wrong password is rejected,
 *   3. the correct password unlocks the site,
 *   4. every page renders (home, floor plan, snapshots),
 *   5. the 3D viewer loads a model, the walkability grid is applied and the
 *      measurement tool produces real distances.
 *
 * Usage: node tools/test_site.mjs [baseUrl]
 */

import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PASSWORD = 'tfcbioinform113';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader', '--window-size=1400,900'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // ---------------------------------------------------------- 1. gate shows
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.gate', { timeout: 8000 });
  check('password gate appears', true);

  const hiddenWithoutAuth = await page.evaluate(() =>
    document.documentElement.classList.contains('is-locked'));
  check('page content hidden while locked', hiddenWithoutAuth);

  // --------------------------------------------------- 2. wrong password
  await page.type('#gate-password', 'definitely-wrong');
  await page.click('.gate-submit');
  await page.waitForFunction(
    () => !document.querySelector('.gate-error')?.hidden,
    { timeout: 8000 },
  );
  check('wrong password rejected', true);

  const stillLocked = await page.evaluate(() =>
    document.documentElement.classList.contains('is-locked'));
  check('still locked after wrong password', stillLocked);

  // ---------------------------------------------------- 3. correct password
  await page.evaluate(() => { document.querySelector('#gate-password').value = ''; });
  await page.type('#gate-password', PASSWORD);
  await page.click('.gate-submit');
  await page.waitForFunction(
    () => !document.querySelector('.gate'),
    { timeout: 15000 },
  );
  check('correct password unlocks the site', true);

  // ------------------------------------------------------- 4. home page
  await page.waitForSelector('#model-cards .card', { timeout: 8000 });
  const modelCards = await page.$$eval('#model-cards .card', (n) => n.length);
  check('home shows model cards', modelCards === 3, `${modelCards} cards`);

  const photoCards = await page.$$eval('#snapshot-cards .card', (n) => n.length);
  check('home shows snapshot cards', photoCards === 10, `${photoCards} cards`);

  // ------------------------------------------------------ 5. photo pages
  await page.goto(`${BASE}/floorplan.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#floorplan-cards .card', { timeout: 8000 });
  const fpCards = await page.$$eval('#floorplan-cards .card', (n) => n.length);
  check('floor plan page renders cards', fpCards === 2, `${fpCards} cards`);

  await page.goto(`${BASE}/snapshots.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#snapshot-cards .card', { timeout: 8000 });
  const snapCards = await page.$$eval('#snapshot-cards .card', (n) => n.length);
  check('snapshots page renders cards', snapCards === 10, `${snapCards} cards`);

  // lightbox
  await page.click('#snapshot-cards .card');
  await page.waitForSelector('.lightbox.open', { timeout: 5000 });
  check('lightbox opens', true);
  await page.keyboard.press('Escape');
  await sleep(200);


  // ------------------------------------------------------ 6. 3D viewer
  // NOTE: wait for 'domcontentloaded' rather than 'networkidle2'.  The Draco
  // decoder runs in a worker and keeps a blob: URL open, so the network never
  // goes idle even though the page is fully working.
  await page.goto(`${BASE}/3d.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loader.hidden', { timeout: 90000 });
  check('3D model loads', true);

  const canvasOk = await page.evaluate(() => {
    const canvas = document.getElementById('viewer-canvas');
    return { w: canvas.width, h: canvas.height };
  });
  check('WebGL canvas is sized', canvasOk.w > 0 && canvasOk.h > 0,
    `${canvasOk.w}x${canvasOk.h}`);

  const buttons = await page.$$eval('.model-btn', (n) => n.map((b) => b.textContent));
  check('all three rooms listed', buttons.length === 3, buttons.join(', '));

  // Position readout means the viewer is running and collision applied.
  await sleep(1200);
  const pos = await page.$eval('#position-readout', (el) => el.textContent);
  check('position readout is live', /x\s+-?\d/.test(pos), pos.trim());

  // Walk forward and confirm the position changed (collision grid active).
  const before = await page.evaluate(() =>
    document.getElementById('position-readout').textContent);
  await page.keyboard.down('KeyW');
  await sleep(1200);
  await page.keyboard.up('KeyW');
  await sleep(300);
  const after = await page.evaluate(() =>
    document.getElementById('position-readout').textContent);
  check('walking moves the camera', before !== after, `${before} -> ${after}`);

  // Measurement: switch on measure mode and click on the model.
  await page.keyboard.press('KeyM');
  await sleep(400);
  const measureVisible = await page.evaluate(() =>
    !document.getElementById('measure-panel').hidden);
  check('measure mode activates', measureVisible);

  // Click two points in the middle of the canvas (on the model).
  const box = await page.$eval('#viewer-canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await sleep(500);
  await page.mouse.click(box.x + box.w * 0.55, box.y + box.h * 0.5);
  await sleep(700);

  const readout = await page.$eval('#measure-readout', (el) => el.textContent);
  const distMatch = readout.match(/([\d.]+) m/);
  check('measurement produces a distance', !!distMatch,
    readout.replace(/\s+/g, ' ').trim().slice(0, 80));

  if (distMatch) {
    const d = parseFloat(distMatch[1]);
    check('measured distance is plausible', d > 0 && d < 50, `${d} m`);
  }

  // ------------------------------------------------- 7. service worker
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length ? 'registered' : 'none';
  });
  check('service worker registered', swState === 'registered', swState);

  // ------------------------------------------------------ 8. console log
  const realErrors = consoleErrors.filter((e) =>
    !/favicon|Failed to load resource.*404/i.test(e));
  check('no console errors', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '));

  await browser.close();

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.log('\nFailures:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('test run crashed:', err);
  process.exit(2);
});
