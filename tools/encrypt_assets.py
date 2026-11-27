"""Encrypt the protected site assets with a key derived from the password.

GitHub Pages cannot authenticate users, so the only way to make the asset
files themselves unreadable without the password is to encrypt them.

Scheme
------
* The password is stretched with PBKDF2-HMAC-SHA256 (600 000 iterations) into
  a 256-bit AES-GCM key.
* Every protected file is encrypted with AES-256-GCM using a fresh random
  96-bit nonce.  The output is ``nonce (12 bytes) || ciphertext || tag``.
* The browser derives the same key from the password and decrypts the files in
  memory before using them.

Files that must stay readable without the password (HTML, CSS, JS, the manifest
and the vendor libraries) are left untouched.

Usage:
    python encrypt_assets.py --password "secret"
    python encrypt_assets.py --password "secret" --decrypt-check
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"

PROTECTED_DIRS = ["assets/models", "assets/img", "assets/collision"]
ITERATIONS = 600_000
KEY_LENGTH = 32
NONCE_LENGTH = 12


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt,
                                iterations, KEY_LENGTH)


def encrypt_file(path: Path, key: bytes) -> bytes:
    """AES-256-GCM encrypt a file: nonce || ciphertext || tag."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = secrets.token_bytes(NONCE_LENGTH)
    aes = AESGCM(key)
    ciphertext = aes.encrypt(nonce, path.read_bytes(), None)
    return nonce + ciphertext


def decrypt_blob(blob: bytes, key: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce, ciphertext = blob[:NONCE_LENGTH], blob[NONCE_LENGTH:]
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def iter_protected_files():
    for rel in PROTECTED_DIRS:
        folder = SITE / rel
        if not folder.exists():
            continue
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                yield path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--password", help="the site password")
    parser.add_argument("--decrypt-check", action="store_true",
                        help="verify that the encrypted files can be read back")
    args = parser.parse_args()

    password = args.password or os.environ.get("SITE_PASSWORD")
    if not password:
        print("provide --password or set SITE_PASSWORD", file=sys.stderr)
        return 1

    salt = secrets.token_bytes(16)
    key = derive_key(password, salt, ITERATIONS)

    total_in = 0
    total_out = 0
    count = 0
    for path in iter_protected_files():
        original = path.stat().st_size
        blob = encrypt_file(path, key)
        path.write_bytes(blob)
        total_in += original
        total_out += len(blob)
        count += 1
        print(f"  {path.relative_to(SITE)}: {original / 1024:.0f} KB -> "
              f"{len(blob) / 1024:.0f} KB")

    print(f"\nencrypted {count} files, {total_in / 1024 / 1024:.1f} MB -> "
          f"{total_out / 1024 / 1024:.1f} MB")

    # Store the salt next to the auth configuration so the browser can derive
    # the same key.
    config = {
        "salt": base64.b64encode(salt).decode(),
        "iterations": ITERATIONS,
        "keyLength": KEY_LENGTH,
        "nonceLength": NONCE_LENGTH,
        "encrypted": True,
    }
    config_path = SITE / "assets" / "js" / "asset-crypto.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(f"crypto config -> {config_path}")

    if args.decrypt_check:
        problems = 0
        for path in iter_protected_files():
            data = decrypt_blob(path.read_bytes(), key)
            name = path.name.lower()
            if name.endswith(".glb"):
                ok = data[:4] == b"glTF"
            elif name.endswith((".jpg", ".jpeg")):
                ok = data[:2] == b"\xff\xd8"
            elif name.endswith(".json"):
                ok = data[:1] == b"{"
            else:
                ok = True
            if not ok:
                problems += 1
                print(f"  WARN {path.name}: decrypted content looks wrong")
        if problems:
            print(f"{problems} files failed the decrypt check", file=sys.stderr)
            return 1
        print("decrypt check OK - all files decrypt correctly")

    return 0


if __name__ == "__main__":
    sys.exit(main())
