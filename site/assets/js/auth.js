/* ==========================================================================
   Password gate.

   GitHub Pages is a static host, so the check necessarily happens in the
   browser.  The password itself is never present in the source: we derive a
   PBKDF2-HMAC-SHA256 hash from what the user types and compare it with the
   hash in auth-config.js.

   A Service Worker (site/sw.js) additionally blocks direct requests for the
   heavy assets (models, photos, collision data) until the site has been
   unlocked, so guessing the URL of a photo is not enough.
   ========================================================================== */

import { AUTH_CONFIG } from './auth-config.js';

const STORAGE_KEY = 'nlb-unlocked';
const COOKIE_NAME = 'nlb_unlocked';

let resolver = null;
let gateEl = null;

/* ------------------------------------------------------------------ utils */

function toBase64(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function fromBase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time-ish comparison of two base64 strings. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Derive the PBKDF2 hash of a candidate password. */
async function derive(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  // NOTE: the salt is binary, so it must be handed to deriveBits as bytes.
  // Passing it through TextEncoder.encode() would stringify the byte array
  // first ("123,45,...") and produce a completely different key.
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: fromBase64(AUTH_CONFIG.salt),
    iterations: AUTH_CONFIG.iterations,
    hash: 'SHA-256',
  }, keyMaterial, 256);
  return toBase64(new Uint8Array(bits));
}

/* --------------------------------------------------------------- session */

function setCookie(value, maxAgeDays) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  const maxAge = maxAgeDays ? `; max-age=${maxAgeDays * 86400}` : '; max-age=0';
  document.cookie = `${COOKIE_NAME}=${value}; path=/; SameSite=Strict${maxAge}${secure}`;
}

export function isUnlocked() {
  try {
    if (sessionStorage.getItem(STORAGE_KEY) === '1') return true;
  } catch { /* private mode */ }
  return document.cookie.includes(`${COOKIE_NAME}=1`);
}

/** Lock the site again (clears the session marker and the cookie). */
export function lock() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  setCookie('0', 0);
  setUnlockedFlag(false);
  // Tell the service worker to block the protected assets again.
  navigator.serviceWorker?.controller?.postMessage({ type: 'NLB_LOCK' });
  navigator.serviceWorker?.ready
    .then((reg) => reg.active?.postMessage({ type: 'NLB_LOCK' }))
    .catch(() => {});
  location.reload();
}

/**
 * Tell the service worker that the visitor has unlocked the site.
 *
 * The worker cannot read the unlock cookie (browsers strip the Cookie
 * header from requests inside a service worker), so the page has to tell it
 * explicitly.
 */
function notifyServiceWorkerUnlocked() {
  const post = (target) => {
    try {
      target?.postMessage({ type: 'NLB_UNLOCK' });
    } catch { /* ignore */ }
  };
  post(navigator.serviceWorker?.controller);
  navigator.serviceWorker?.ready
    .then((reg) => post(reg.active))
    .catch(() => {});
}

/* ------------------------------------------------------------------ gate */

function buildGate() {
  if (gateEl) return gateEl;

  gateEl = document.createElement('div');
  gateEl.className = 'gate';
  gateEl.innerHTML = `
    <form class="gate-card" autocomplete="off">
      <div class="gate-lock">&#128274;</div>
      <h1>New Lab Block</h1>
      <p class="gate-sub">This site is private. Please enter the password.</p>
      <label class="sr-only" for="gate-password">Password</label>
      <input id="gate-password" type="password" placeholder="Password"
             autocomplete="current-password" spellcheck="false" required>
      <button type="submit" class="btn btn-primary gate-submit">Unlock</button>
      <p class="gate-error" role="alert" hidden>Wrong password - please try again.</p>
    </form>`;

  document.body.appendChild(gateEl);
  document.documentElement.classList.add('is-locked');

  const form = gateEl.querySelector('form');
  const input = gateEl.querySelector('#gate-password');
  const error = gateEl.querySelector('.gate-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const button = gateEl.querySelector('.gate-submit');
    button.disabled = true;
    button.textContent = 'Checking...';

    try {
      const candidate = await derive(input.value);
      if (!safeEqual(candidate, AUTH_CONFIG.hash)) {
        error.hidden = false;
        input.value = '';
        input.focus();
        button.disabled = false;
        button.textContent = 'Unlock';
        return;
      }
      // Success: remember for this browser session and let the site through.
      try {
        sessionStorage.setItem(STORAGE_KEY, '1');
        localStorage.setItem(STORAGE_KEY, '1');
      } catch { /* ignore */ }
      setCookie('1', 7);
      document.documentElement.classList.remove('is-locked');
      gateEl.remove();
      gateEl = null;
      // Persist the flag so the service worker lets the assets through.
      await setUnlockedFlag(true);
      notifyServiceWorkerUnlocked();
      if (resolver) resolver();
    } catch (err) {
      error.hidden = false;
      error.textContent = 'Could not verify the password in this browser.';
      button.disabled = false;
      button.textContent = 'Unlock';
    }
  });

  setTimeout(() => input.focus(), 30);
  return gateEl;
}

/**
 * Ensure the visitor has entered the password.
 *
 * Resolves once the site may be shown; the caller can then load the heavy
 * assets.  On an already-unlocked browser it resolves immediately.
 */
export function requireAuth() {
  if (isUnlocked()) {
    document.documentElement.classList.remove('is-locked');
    registerServiceWorker();
    notifyServiceWorkerUnlocked();
    return Promise.resolve();
  }

  buildGate();

  return new Promise((resolve) => {
    resolver = resolve;
  });
}

/* ------------------------------------------------------- unlock database */

/*
 * The unlock flag lives in IndexedDB so that both the page and the service
 * worker can read it.  A cookie cannot be used: browsers strip the Cookie
 * header from Request objects inside a service worker.
 */
const DB_NAME = 'nlb-auth';
const DB_STORE = 'state';
const UNLOCK_KEY = 'unlocked';

function openAuthDb() {
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

/** Persist the unlock flag so the service worker can see it. */
export async function setUnlockedFlag(value) {
  try {
    const db = await openAuthDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, UNLOCK_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage is optional - the worker falls back to the message below */
  }
}

/**
 * Register the Service Worker that blocks direct asset access.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    notifyServiceWorkerUnlocked();
  } catch {
    /* Offline support is a bonus - the site works without it. */
  }
}

/** Add a "Lock" button to the header once the site is open. */
export function initLockButton() {
  const nav = document.querySelector('.site-nav');
  if (!nav || nav.querySelector('.lock-btn')) return;

  const button = document.createElement('a');
  button.className = 'lock-btn';
  button.href = '#';
  button.textContent = 'Lock';
  button.title = 'Lock the site again';
  button.addEventListener('click', (e) => {
    e.preventDefault();
    lock();
  });
  nav.appendChild(button);
}

