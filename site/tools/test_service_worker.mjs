/* Test the service worker's caching strategy.
 *
 * This reproduces the situation of a *returning* visitor: a browser profile
 * that already has the service worker installed and controlling the page.
 * The site files are then changed on disk (as they would be by a new
 * deployment) and the page is reloaded.
 *
 * A cache-first worker would keep serving the old files - which is exactly
 * what made the "clip through objects" feature appear to do nothing.
 *
 * The test runs against a throw-away copy of the site so that the real files
 * are never modified.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

async function main() {
  // --- build a throw-away copy of the site ---------------------------
  const root = await mkdtemp(join(tmpdir(), 'nlb-sw-'));
  await mkdir(join(root, 'assets/js'), { recursive: true });
  await mkdir(join(root, 'assets/css'), { recursive: true });
  await copyFile(join(SITE, 'sw.js'), join(root, 'sw.js'));

  // Every file the worker pre-caches has to exist, otherwise its install
  // step waits for the missing ones.
  const swSource = await readFile(join(SITE, 'sw.js'), 'utf8');
  const shell = [...swSource.matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((rel) => rel.includes('.') || rel.endsWith('/'))
    .filter((rel) => !rel.startsWith('http'));
  for (const rel of shell) {
    if (rel === './') continue;
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `/* ${rel} */`);
  }
  await writeFile(join(root, 'version.txt'), 'VERSION-1');

  // A minimal page that registers the service worker the same way the real
  // site does (see assets/js/auth.js).
  await writeFile(join(root, 'index.html'),
    '<!DOCTYPE html><html><head><title>sw test</title></head>'
    + '<body><h1>service worker test</h1>'
    + '<script>if ("serviceWorker" in navigator) '
    + 'navigator.serviceWorker.register("sw.js");</script>'
    + '</body></html>');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const name = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(root, name);
      const body = await readFile(file);
      const ext = name.slice(name.lastIndexOf('.'));
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`test server on ${base}\n`);

  // A persistent profile = a returning visitor.
  const profile = await mkdtemp(join(tmpdir(), 'nlb-profile-'));
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const page = await browser.newPage();

  // --- first visit: the worker installs and takes over ----------------
  await page.goto(`${base}/`, { waitUntil: 'load' });
  // Wait for the worker to be installed and to control the page.
  const controlling = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // The worker has just been installed; a reload hands control over.
      return false;
    }
    return true;
  });
  if (!controlling) {
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
  }
  const nowControlling = await page.evaluate(
    () => !!navigator.serviceWorker.controller);
  check('service worker controls the page', nowControlling);

  const first = await page.evaluate(async () => {
    const res = await fetch('version.txt');
    return res.text();
  });
  check('first fetch works', first === 'VERSION-1', first);

  // --- deploy a new version -------------------------------------------
  console.log('\n  (deploying VERSION-2 ...)');
  await writeFile(join(root, 'version.txt'), 'VERSION-2');
  // The worker itself did not change, so it stays installed and in control.
  await page.reload({ waitUntil: 'load' });

  const second = await page.evaluate(async () => {
    const res = await fetch('version.txt');
    return res.text();
  });
  check('a returning visitor gets the NEW file', second === 'VERSION-2', second);

  // The same for a plain navigation.
  await page.goto(`${base}/`, { waitUntil: 'load' });
  const navText = await page.evaluate(() => document.body.innerText.length);
  check('navigation still works after the deploy', navText > 0);

  // --- and the worker does pick up a changed sw.js ---------------------
  await writeFile(join(root, 'sw.js'),
    (await readFile(join(SITE, 'sw.js'), 'utf8')).replace("'nlb-site-v4'", "'nlb-site-v5'"));
  await page.reload({ waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2000));
  const reg = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.map((r) => r.active?.scriptURL);
  });
  check('a changed sw.js is picked up', reg.length > 0, reg.join(', '));

  await browser.close();
  server.close();

  console.log(failures ? `\n${failures} failures` : '\nService worker checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
