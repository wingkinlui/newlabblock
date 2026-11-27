/* ==========================================================================
   Service Worker - blocks direct access to the heavy assets until the
   visitor has unlocked the site.

   GitHub Pages has no server-side auth, so this is the part that stops
   somebody from simply linking to assets/models/openlab.glb without knowing
   the password.

   Unlocking
   ---------
   The page posts an 'NLB_UNLOCK' message to the worker once the correct
   password has been entered.  The flag is kept in memory and persisted in
   IndexedDB so it survives a browser restart.

   NOTE: the unlock state cannot be read from the request cookie - browsers
   strip the Cookie header from Request objects inside a service worker, so
   request.headers.get('cookie') is always null there.
   ========================================================================== */

const CACHE = 'nlb-site-v2';
const DB_NAME = 'nlb-auth';
const DB_STORE = 'state';
const UNLOCK_KEY = 'unlocked';

const PROTECTED = [
  'assets/models/',
  'assets/img/',
  'assets/collision/',
];

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
  'assets/js/viewer.js',
  'assets/js/viewer-page.js',
];

let unlocked = false;

/* ------------------------------------------------------------- IndexedDB */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readUnlocked() {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(UNLOCK_KEY);
      req.onsuccess = () => resolve(req.result === true);
      req.onerror = () => reject(req.error);
      // Never let a blocked transaction hang the request.
      setTimeout(() => resolve(false), 1000);
    });
    db.close();
    return value;
  } catch {
    return false;
  }
}

async function writeUnlocked(value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, UNLOCK_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage is optional */
  }
}


/* -------------------------------------------------------------- messages */

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'NLB_UNLOCK') {
    unlocked = true;
    writeUnlocked(true);
    if (event.source?.postMessage) {
      event.source.postMessage({ type: 'NLB_UNLOCKED' });
    }
  } else if (data.type === 'NLB_LOCK') {
    unlocked = false;
    writeUnlocked(false);
  }
});

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
  // Read the persisted flag, but never block activation on it.
  readUnlocked().then((value) => { unlocked = value; });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isProtected(url)) {
    event.respondWith((async () => {
      // Check the persisted unlock flag on every request: the worker may
      // have been activated before the visitor entered the password.
      const allowed = unlocked || (await readUnlocked());
      if (!allowed) {
        return new Response('Site locked - enter the password first.', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return serveAsset(request);
    })());
    return;
  }

  event.respondWith(serveAsset(request));
});

async function serveAsset(request) {
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
}
