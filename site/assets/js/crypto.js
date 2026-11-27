/* ==========================================================================
   Client-side decryption of the protected assets.

   The models, photos and collision grids are stored on GitHub Pages as
   AES-256-GCM ciphertext.  The key is derived from the site password with
   PBKDF2-HMAC-SHA256, so the files are unreadable without it - not even by
   downloading them straight from the repository.

   The plaintext password is never kept: the page verifies it against the
   hash in auth-config.js, and this module derives the *encryption* key from
   the same password at unlock time.

   File layout on disk:  nonce (12 bytes) || ciphertext || GCM tag (16 bytes)
   ========================================================================== */

import { AUTH_CONFIG } from './auth-config.js';

let cachedKey = null;
let cryptoConfigPromise = null;
let keyDbPromise = null;

/* ------------------------------------------------------------ key storage */

/*
 * The derived AES key is stored in IndexedDB as a non-extractable CryptoKey.
 * That way it survives a page reload (and a browser restart) without the
 * password being typed again, while the raw key material never leaves the
 * browser and cannot be read back out of storage.
 */
const KEY_DB = 'nlb-keys';
const KEY_STORE = 'keys';
const KEY_ID = 'asset-key';

function openKeyDb() {
  if (!keyDbPromise) {
    keyDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(KEY_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(KEY_STORE)) {
          request.result.createObjectStore(KEY_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return keyDbPromise;
}

async function storeKey(key) {
  try {
    const db = await openKeyDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).put(key, KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('could not persist the asset key', err);
  }
}

async function loadStoredKey() {
  try {
    const db = await openKeyDb();
    const key = await new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readonly');
      const req = tx.objectStore(KEY_STORE).get(KEY_ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return key;
  } catch {
    return null;
  }
}

async function deleteStoredKey() {
  try {
    const db = await openKeyDb();
    await new Promise((resolve) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).delete(KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* ignore */ }
}

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

/** Fetch the encryption parameters (salt, iteration count). */
async function getCryptoConfig() {
  if (!cryptoConfigPromise) {
    cryptoConfigPromise = fetch('assets/js/asset-crypto.json')
      .then((res) => {
        if (!res.ok) throw new Error(`asset-crypto.json: ${res.status}`);
        return res.json();
      });
  }
  return cryptoConfigPromise;
}

/**
 * Derive the AES-GCM key from the password.
 *
 * The password is stretched with PBKDF2 over the *encryption* salt.  This is
 * deliberately a different salt from the verification hash, so the two
 * derivations are independent.
 */
export async function deriveAssetKey(password) {
  const config = await getCryptoConfig();
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  // The salt is binary, so it must be passed to deriveBits as bytes -
  // running it through TextEncoder would stringify it first.
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: fromBase64(config.salt),
    iterations: config.iterations,
    hash: 'SHA-256',
  }, keyMaterial, config.keyLength * 8);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
}

/** Derive, cache and persist the asset key. */
export async function setAssetKey(password) {
  cachedKey = await deriveAssetKey(password);
  await storeKey(cachedKey);
  return cachedKey;
}

/**
 * Restore a previously derived key (after a reload).
 *
 * Returns true when a usable key was found.
 */
export async function restoreAssetKey() {
  if (cachedKey) return true;
  const stored = await loadStoredKey();
  if (stored) {
    cachedKey = stored;
    return true;
  }
  return false;
}

export function hasAssetKey() {
  return cachedKey !== null;
}

export async function clearAssetKey() {
  cachedKey = null;
  await deleteStoredKey();
}

/**
 * Download and decrypt a protected asset.
 *
 * Returns an ArrayBuffer of the original (plaintext) file.
 */
export async function fetchDecrypted(url) {
  if (!cachedKey) throw new Error('the asset key has not been derived yet');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);

  const blob = await res.arrayBuffer();
  const config = await getCryptoConfig();
  const nonceLength = config.nonceLength || 12;

  const nonce = new Uint8Array(blob, 0, nonceLength);
  const ciphertext = new Uint8Array(blob, nonceLength);

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    cachedKey,
    ciphertext,
  );
  return plain;
}

/**
 * Decrypt an asset and hand it to the GLTF loader as a blob URL.
 *
 * Three.js can load a .glb from a blob URL, so the model works exactly as
 * before - the only difference is where the bytes come from.
 */
export async function loadDecryptedGLTF(loader, url) {
  const plain = await fetchDecrypted(url);
  const blobUrl = URL.createObjectURL(new Blob([plain], { type: 'model/gltf-binary' }));
  try {
    return await loader.loadAsync(blobUrl);
  } finally {
    // Give the loader a moment to finish reading before revoking.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  }
}

/** Decrypt an image and return an object URL for it. */
export async function loadDecryptedImage(url) {
  const plain = await fetchDecrypted(url);
  return URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
}

/** Decrypt a JSON asset (collision grid) and parse it. */
export async function loadDecryptedJSON(url) {
  const plain = await fetchDecrypted(url);
  return JSON.parse(new TextDecoder().decode(plain));
}
