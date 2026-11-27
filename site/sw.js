/* ==========================================================================
   Service Worker - offline support for the site.

   The heavy assets (models, photos, collision grids) are stored encrypted:
   they are AES-256-GCM ciphertext that only the browser can decrypt with a
   key derived from the site password.  The worker therefore does not need to
   hide them - it cannot read them either.

   What the worker does provide is offline caching, so the site keeps working
   (and the models stay browsable) without a network connection.
   ========================================================================== */

const CACHE = 'nlb-site-v3';

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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
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

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      // Offline fallback for the shell pages.
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
      throw err;
    }
  })());
});
