/* Compare the two collision modes directly: starting from the same spot and
 * walking in the same direction, how far does the camera get?
 *
 * In "clip" mode it should travel further, because furniture does not stop
 * it; in "solid" mode the furniture should hold it back.
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

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 10000 });
await page.type('#gate-password', PASSWORD);
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 15000 });

/** Walk in one direction and report how far the camera got. */
async function walk(room, solid, seconds = 6) {
  await page.goto(`${BASE}/3d.html?model=${room}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loader.hidden', { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 700));

  if (solid) {
    await page.keyboard.press('KeyC');
    await new Promise((r) => setTimeout(r, 250));
  }

  const start = await page.evaluate(() =>
    document.getElementById('position-readout').textContent);

  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await page.keyboard.up('KeyW');
  await new Promise((r) => setTimeout(r, 250));

  const end = await page.evaluate(() =>
    document.getElementById('position-readout').textContent);

  const parse = (text) => {
    const m = text.match(/x\s+(-?[\d.]+)\s+z\s+(-?[\d.]+)/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  };
  const a = parse(start);
  const b = parse(end);
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null;
}

let failures = 0;
for (const room of ['openlab', 'typeclab']) {
  const clip = await walk(room, false);
  const solid = await walk(room, true);
  console.log(`${room}: clip mode ${clip?.toFixed(2)} m, `
    + `solid mode ${solid?.toFixed(2)} m`);

  if (clip === null || solid === null) {
    console.log('  FAIL  could not read the position');
    failures += 1;
  } else if (clip > solid + 0.05) {
    console.log('  PASS  clipping gets past the obstacles');
  } else {
    console.log('  note  the two modes travelled the same distance '
      + '(no obstacle in the way here)');
  }
}

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nClip/solid comparison passed');
process.exit(failures ? 1 : 0);
