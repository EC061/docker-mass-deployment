import os

import pytest
from cryptography.exceptions import InvalidTag

from lab_agent import crypto


def test_roundtrip(tmp_path):
    key = crypto.load_or_create_key(tmp_path / "queue.key")
    payload = {"type": "task", "params": {"password": "s3cret", "n": 5}, "list": [1, 2, 3]}
    env = crypto.encrypt_payload(key, payload)
    assert set(env.keys()) == {"_enc"}
    assert "s3cret" not in env["_enc"]  # ciphertext is opaque
    assert crypto.decrypt_payload(key, env) == payload


def test_decrypt_passthrough_for_plaintext(tmp_path):
    key = crypto.load_or_create_key(tmp_path / "queue.key")
    # A dict without the envelope marker (a pre-encryption entry) is returned unchanged.
    assert crypto.decrypt_payload(key, {"type": "task", "id": "x"}) == {"type": "task", "id": "x"}


def test_key_is_persisted_and_stable(tmp_path):
    path = tmp_path / "queue.key"
    k1 = crypto.load_or_create_key(path)
    k2 = crypto.load_or_create_key(path)
    assert k1 == k2 and len(k1) == 32
    assert (os.stat(path).st_mode & 0o777) == 0o600


def test_wrong_key_fails_to_decrypt(tmp_path):
    k1 = crypto.load_or_create_key(tmp_path / "a.key")
    k2 = crypto.load_or_create_key(tmp_path / "b.key")
    env = crypto.encrypt_payload(k1, {"x": 1})
    with pytest.raises(InvalidTag):
        crypto.decrypt_payload(k2, env)
