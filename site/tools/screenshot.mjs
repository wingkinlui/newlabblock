/* Capture screenshots of the live site for a visual check. */

import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'https://wingkinlui.github.io/newlabblock';
const OUT = process.argv[3] || 'D:\\NewLabBlock\\work';
const PASSWORD = 'tfcbioinform113';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// 1. the password gate
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 15000 });
await page.screenshot({ path: `${OUT}/shot-1-gate.png` });
console.log('saved shot-1-gate.png');

// 2. the home page
await page.type('#gate-password', PASSWORD);
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 25000 });
await page.waitForSelector('#snapshot-cards .card', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${OUT}/shot-2-home.png` });
console.log('saved shot-2-home.png');

// 3. the floor plan
await page.goto(`${BASE}/floorplan.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#floorplan-cards .card', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: `${OUT}/shot-3-floorplan.png` });
console.log('saved shot-3-floorplan.png');

// 4. the 3D viewer
await page.goto(`${BASE}/3d.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loader.hidden', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${OUT}/shot-4-viewer.png` });
console.log('saved shot-4-viewer.png');

// 5. measure mode with two points
await page.keyboard.press('KeyM');
await new Promise((r) => setTimeout(r, 500));
const box = await page.$eval('#viewer-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(box.x + box.w * 0.42, box.y + box.h * 0.52);
await new Promise((r) => setTimeout(r, 600));
await page.mouse.click(box.x + box.w * 0.58, box.y + box.h * 0.46);
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${OUT}/shot-5-measure.png` });
console.log('saved shot-5-measure.png');

const readout = await page.$eval('#measure-readout', (el) => el.textContent);
console.log('measurement readout:', readout.replace(/\s+/g, ' ').trim());

await browser.close();
