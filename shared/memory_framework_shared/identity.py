"""Canonical source fingerprints; transport identity is separate from content."""
import hashlib
import json

def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
