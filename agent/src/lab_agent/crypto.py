"""At-rest encryption for the agent's local queue + result journal.

Task payloads pushed from the controller carry student passwords (``student.add``). They are
buffered on disk in the local queue until executed, so they must not sit there in plaintext. We
encrypt every persisted payload with AES-256-GCM under a random key at ``<state_dir>/queue.key``
(0600); the state dir is 0700, so only root can read the key. The local queue DB is never backed up
off-node, so a copied DB without the key file is useless — encryption is defence-in-depth on top.

A payload is stored as a one-key envelope ``{"_enc": "<base64(nonce|ciphertext)>"}``. ``decrypt`` is
tolerant: a dict without ``_enc`` (a pre-encryption / plaintext entry) is returned unchanged, so an
older queue keeps draining after an upgrade.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENVELOPE_KEY = "_enc"
NONCE_LEN = 12


def load_or_create_key(path: Path) -> bytes:
    """Read the 32-byte queue key, generating + persisting one (0600) on first use."""
    try:
        data = path.read_bytes()
        if len(data) == 32:
            return data
    except OSError:
        pass
    key = AESGCM.generate_key(bit_length=256)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Create 0600 from the start (O_CREAT mode) so the key is never briefly world-readable.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, key)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)
    return key


def encrypt_payload(key: bytes, obj: Any) -> dict[str, str]:
    """Encrypt a JSON-serializable payload into a ``{"_enc": ...}`` envelope."""
    nonce = os.urandom(NONCE_LEN)
    plaintext = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
    return {ENVELOPE_KEY: base64.b64encode(nonce + ciphertext).decode("ascii")}


def decrypt_payload(key: bytes, stored: Any) -> Any:
    """Decrypt a ``{"_enc": ...}`` envelope. A value without the envelope is returned unchanged."""
    if not isinstance(stored, dict) or ENVELOPE_KEY not in stored:
        return stored
    blob = base64.b64decode(stored[ENVELOPE_KEY])
    nonce, ciphertext = blob[:NONCE_LEN], blob[NONCE_LEN:]
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, None)
    return json.loads(plaintext)
