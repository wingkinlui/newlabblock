/* Verify the site works when served from a sub-directory, which is how a
 * GitHub project page (https://<user>.github.io/<repo>/) is served.
 */

import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8098/site';
const PASSWORD = 'tfcbioinform113';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 10000 });
check('gate appears under a sub-directory', true);

await page.type('#gate-password', PASSWORD);
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 20000 });
check('unlocked', true);

await page.waitForSelector('#model-cards .card', { timeout: 15000 });
const cards = await page.$$eval('#model-cards .card', (n) => n.length);
check('home page renders model cards', cards === 3, `${cards} cards`);

const thumbOk = await page.evaluate(() => {
  const img = document.querySelector('#snapshot-cards .card img');
  return img ? img.src.startsWith('blob:') : false;
});
check('encrypted thumbnails load as blob URLs', thumbOk);

await page.goto(`${BASE}/3d.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loader.hidden', { timeout: 90000 });
check('3D model loads from a sub-directory', true);

const pos = await page.$eval('#position-readout', (el) => el.textContent);
check('viewer position is live', /x\s+-?\d/.test(pos), pos.trim());

// The model switcher must work too.
await page.click('.model-btn:nth-child(3)');
await new Promise((r) => setTimeout(r, 8000));
const active = await page.$eval('.model-btn.active', (b) => b.textContent);
check('model switcher works', active === 'TF Office', active);

const realErrors = errors.filter((e) => !/favicon/i.test(e));
check('no console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nSub-directory deployment check passed');
process.exit(failures ? 1 : 0);
