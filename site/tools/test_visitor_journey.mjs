/* Simulate a brand-new visitor with a clean browser profile:
 *
 *   1. the site asks for the password,
 *   2. the protected files downloaded directly are unreadable ciphertext,
 *   3. after unlocking they decrypt correctly,
 *   4. the whole site can be walked through,
 *   5. the unlock survives a reload.
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

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// --- 1. the gate appears --------------------------------------------------
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gate', { timeout: 10000 });
check('gate shown to a new visitor', true);

// --- 2. the raw files are unreadable -------------------------------------
const raw = await page.evaluate(async () => {
  const read = async (url) => {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      first: Array.from(buf.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' '),
      isGlb: Array.from(buf.slice(0, 4)).map((b) => String.fromCharCode(b)).join('') === 'glTF',
      isJpeg: buf[0] === 0xff && buf[1] === 0xd8,
      isJson: buf[0] === 0x7b,
    };
  };
  return {
    model: await read('assets/models/openlab.glb'),
    photo: await read('assets/img/Building.jpg'),
    grid: await read('assets/collision/openlab.collision.json'),
  };
});

check('model file is ciphertext, not a readable GLB',
  !raw.model.isGlb, `magic ${raw.model.first}`);
check('photo file is ciphertext, not a readable JPEG',
  !raw.photo.isJpeg, `magic ${raw.photo.first}`);
check('collision grid is ciphertext, not readable JSON',
  !raw.grid.isJson, `magic ${raw.grid.first}`);
check('the files are still served over HTTP',
  raw.model.status === 200 && raw.photo.status === 200,
  `model ${raw.model.status}, photo ${raw.photo.status}`);

// --- 3. unlock ------------------------------------------------------------
await page.type('#gate-password', PASSWORD);
await page.click('.gate-submit');
await page.waitForFunction(() => !document.querySelector('.gate'), { timeout: 20000 });
check('unlocked with the correct password', true);

const decrypted = await page.evaluate(async () => {
  const mod = await import('./assets/js/crypto.js');
  const model = await mod.fetchDecrypted('assets/models/openlab.glb');
  const grid = await mod.loadDecryptedJSON('assets/collision/openlab.collision.json');
  const photo = new Uint8Array(await mod.fetchDecrypted('assets/img/Building.jpg'));
  const magic = Array.from(new Uint8Array(model.slice(0, 4)))
    .map((b) => String.fromCharCode(b)).join('');
  return {
    magic,
    modelBytes: model.byteLength,
    gridCells: grid.rle?.length || 0,
    photoIsJpeg: photo[0] === 0xff && photo[1] === 0xd8,
    photoBytes: photo.length,
  };
});
check('model decrypts to a valid GLB', decrypted.magic === 'glTF',
  `${decrypted.magic}, ${decrypted.modelBytes} bytes`);
check('collision grid decrypts to valid JSON', decrypted.gridCells > 0,
  `${decrypted.gridCells} rows`);
check('photo decrypts to a valid JPEG', decrypted.photoIsJpeg);

// --- 4. walk the whole site -----------------------------------------------
const pages = [
  ['index.html', '#model-cards .card'],
  ['floorplan.html', '#floorplan-cards .card'],
  ['snapshots.html', '#snapshot-cards .card'],
  ['3d.html', '#loader.hidden'],
];
for (const [file, selector] of pages) {
  await page.goto(`${BASE}/${file}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector(selector, { timeout: 60000 });
    check(`${file} renders`, true);
  } catch {
    check(`${file} renders`, false, 'timed out');
  }
}

// --- 5. the unlock survives a reload --------------------------------------
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 1500));
const gateAfterReload = await page.$('.gate');
check('still unlocked after reload', !gateAfterReload);

// The key must have been restored from IndexedDB so the assets still load.
const afterReload = await page.evaluate(async () => {
  const mod = await import('./assets/js/crypto.js');
  const ok = await mod.restoreAssetKey();
  if (!ok) return { ok };
  const model = await mod.fetchDecrypted('assets/models/openlab.glb');
  return {
    ok,
    magic: Array.from(new Uint8Array(model.slice(0, 4)))
      .map((b) => String.fromCharCode(b)).join(''),
  };
});
check('asset key restored after reload', afterReload.ok, JSON.stringify(afterReload));

await browser.close();
console.log(failures ? `\n${failures} failures` : '\nAll visitor-journey checks passed');
process.exit(failures ? 1 : 0);
