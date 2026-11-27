/* Test the site the way a *returning* visitor sees it.
 *
 * A persistent browser profile is used, so the service worker is installed
 * and controlling the page - which is exactly the situation that hid the
 * "clip through objects" feature before.
 *
 * Checks:
 *   1. the COLLISION panel is present on 3d.html,
 *   2. it is also present when the page is opened through the header link
 *      (no query string),
 *   3. the clip toggle actually changes the collision behaviour,
 *   4. everything still works after a reload.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PASSWORD = 'tfcbioinform113';

const profile = await mkdtemp(join(tmpdir(), 'nlb-returning-'));
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  userDataDir: profile,
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

async function unlock() {
  await page.waitForSelector('.gate', { timeout: 15000 });
  await page.type('#gate-password', PASSWORD);
  await page.click('.gate-submit');
  await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 20000 });
}

// --- first visit --------------------------------------------------------
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await unlock();
await page.waitForSelector('#model-cards .card', { timeout: 15000 });
check('home page renders', true);

// Let the service worker install and take over.
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.evaluate(() => navigator.serviceWorker.ready);

const controlling = await page.evaluate(() => !!navigator.serviceWorker.controller);
check('service worker controls the page (returning visitor)', controlling);

// --- open 3d.html exactly like the header link does -------------------
await page.goto(`${BASE}/3d.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loader.hidden', { timeout: 120000 });

const panelVisible = await page.evaluate(() => {
  const panel = document.getElementById('clip-toggle');
  if (!panel) return false;
  const rect = panel.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
});
check('COLLISION panel is visible on /3d.html (no query string)', panelVisible);

const stateText = await page.$eval('#clip-state', (el) => el.textContent.trim());
check('clip state is shown', /Clipping through objects/i.test(stateText), stateText);

// --- the toggle has to actually do something ---------------------------
const before = await page.$eval('#clip-toggle', (el) => el.classList.contains('solid'));
await page.click('#clip-toggle');
await new Promise((r) => setTimeout(r, 400));
const after = await page.$eval('#clip-toggle', (el) => el.classList.contains('solid'));
check('the Collision button toggles the mode', before !== after,
  `${before} -> ${after}`);

const stateAfter = await page.$eval('#clip-state', (el) => el.textContent.trim());
check('the label follows the state', /Solid objects/i.test(stateAfter), stateAfter);

// Back to clipping.
await page.click('#clip-toggle');
await new Promise((r) => setTimeout(r, 400));

// --- the keyboard shortcut ----------------------------------------------
await page.keyboard.press('KeyC');
await new Promise((r) => setTimeout(r, 400));
const viaKey = await page.$eval('#clip-toggle', (el) => el.classList.contains('solid'));
check('the C key toggles the mode too', viaKey === true);
await page.keyboard.press('KeyC');

// --- and the viewer code is the new one ---------------------------------
const clipCodePresent = await page.evaluate(async () => {
  const src = await (await fetch('assets/js/viewer.js')).text();
  return src.includes('toggleSolidObjects') && src.includes('OBJECT');
});
check('the viewer code served is the current build', clipCodePresent);

// --- still working after a reload ---------------------------------------
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loader.hidden', { timeout: 120000 });
const panelAfterReload = await page.$eval('#clip-state', (el) => el.textContent.trim());
check('the panel survives a reload', /Clipping through objects/i.test(panelAfterReload),
  panelAfterReload);

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nReturning-visitor checks passed');
process.exit(failures ? 1 : 0);
