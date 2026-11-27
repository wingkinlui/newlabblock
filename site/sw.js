/* ==========================================================================
   Service Worker - offline support for the site.

   The heavy assets (models, photos, collision grids) are stored encrypted:
   they are AES-256-GCM ciphertext that only the browser can decrypt with a
   key derived from the site password.  The worker therefore does not need to
   hide them - it cannot read them either.

   Caching strategy
   ----------------
   The site files (HTML, CSS, JS) are fetched **network first** and only fall
   back to the cache when the network is unavailable.  A cache-first worker
   would keep serving an old build after a deploy - which is exactly the bug
   that made the "clip through objects" feature appear to do nothing: the
   page was still running the previous viewer.js from the cache.

   The big assets (models, photos) are fetched from the network as well, but
   they are cached afterwards so that a second visit works offline.
   ========================================================================== */

const CACHE = 'nlb-site-v5';

const SHELL = [
  './',
  'index.html',
  '3d.html',
  'floorplan.html',
  'snapshots.html',
  'assets/css/style.css',
  'assets/css/auth.css',
  'assets/css/viewer.css',
  'assets/js/common.js',
  'assets/js/auth.js',
  'assets/js/auth-config.js',
  'assets/js/crypto.js',
  'assets/js/asset-crypto.json',
  'assets/js/viewer.js',
  'assets/js/viewer-page.js',
  'assets/manifest.json',
];

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'NLB_SKIP_WAITING') {
    // The page asked to activate the new worker straight away.
    self.skipWaiting();
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL).catch(() => {});
    // A changed sw.js means a new build has been deployed.  Tell the open
    // pages so they can offer a reload instead of silently running the old
    // code.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.postMessage({ type: 'NLB_NEW_VERSION' }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache from an older version of the site.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Range requests (used when streaming media) must not be intercepted.
  if (request.headers.has('range')) return;

  event.respondWith(networkFirst(request));
});

/**
 * Fetch from the network and fall back to the cache.
 *
 * The response is always the fresh one when the network is reachable, so a
 * new deployment is picked up immediately.
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline: use the cached copy.
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
    throw err;
  }
}
