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
  // Drop the stored asset decryption key.
  import('./crypto.js')
    .then((m) => m.clearAssetKey())
    .catch(() => {});
  location.reload();
}

/**
 * Tell the service worker that the visitor has unlocked the site.
 *
 * The worker only provides offline caching now, so this is a no-op hint that
 * lets it refresh its cache of the shell files.
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
      const password = input.value;
      const candidate = await derive(password);
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

      // Derive the asset decryption key from the password.  This has to happen
      // before the form is removed, because removing it clears the input.
      try {
        const { setAssetKey } = await import('./crypto.js');
        await setAssetKey(password);
      } catch (err) {
        console.warn('could not derive the asset key', err);
      }

      gateEl.remove();
      gateEl = null;
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
export async function requireAuth() {
  // Register the service worker for offline support.
  registerServiceWorker();

  if (isUnlocked()) {
    document.documentElement.classList.remove('is-locked');
    notifyServiceWorkerUnlocked();
    // Restore the asset decryption key saved in a previous session, so the
    // page can decrypt the models and photos straight away.
    await restoreAssetKey();
    return;
  }

  buildGate();

  return new Promise((resolve) => {
    resolver = resolve;
  });
}

/** Re-import the crypto helpers (kept in a function to avoid a cycle). */
async function restoreAssetKey() {
  try {
    const { restoreAssetKey: restore } = await import('./crypto.js');
    await restore();
  } catch (err) {
    console.warn('could not restore the asset key', err);
  }
}

/* ------------------------------------------------------- unlock database */

/**
 * Register the Service Worker that provides offline caching.
 *
 * NOTE: on the very first visit the worker is installed but does not control
 * the page yet, so it cannot intercept the requests of that first page load.
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

