"""Passwords (Argon2id), JWT sessions, role permissions (SRS §4.10), secret encryption."""
import base64
import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from .config import settings

_ph = PasswordHasher()

def hash_password(pw: str) -> str:
    return _ph.hash(pw)

def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, pw)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def create_token(user_id: str, org_id: str, role: str) -> str:
    payload = {
        "sub": user_id, "org": org_id, "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")

def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


# --- Permission matrix (SRS §4.10) ---
ROLES = ("admin", "qa_lead", "qa_engineer", "viewer")

PERMISSIONS: dict[str, set[str]] = {
    "manage_members":      {"admin"},
    "manage_projects":     {"admin", "qa_lead"},
    "manage_environments": {"admin", "qa_lead"},
    "upload_documents":    {"admin", "qa_lead", "qa_engineer"},
    "edit_requirements":   {"admin", "qa_lead", "qa_engineer"},
    "import_spec":         {"admin", "qa_lead", "qa_engineer"},
    "generate":            {"admin", "qa_lead", "qa_engineer"},
    "edit_test_case":      {"admin", "qa_lead", "qa_engineer"},
    "approve_reject":      {"admin", "qa_lead"},
    "trigger_run":         {"admin", "qa_lead", "qa_engineer"},
    "view":                {"admin", "qa_lead", "qa_engineer", "viewer"},
    "export":              {"admin", "qa_lead", "qa_engineer", "viewer"},
    "view_audit_log":      {"admin", "qa_lead"},
}

def has_permission(role: str, capability: str) -> bool:
    return role in PERMISSIONS.get(capability, set())


# --- Environment secret encryption (NFR-SEC-02, simplified envelope) ---
def _derive_key() -> bytes:
    return hashlib.sha256(("traceo-secrets:" + settings.SECRET_KEY).encode()).digest()

def encrypt_secret(data: dict) -> bytes:
    """AES-GCM when 'cryptography' is available; HMAC-sealed XOR-stream fallback keeps
    the MVP dependency-light. Key custody outside the DB per NFR-SEC-02."""
    raw = json.dumps(data).encode()
    key = _derive_key()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = os.urandom(12)
        return b"AGCM" + nonce + AESGCM(key).encrypt(nonce, raw, None)
    except Exception:
        nonce = os.urandom(16)
        stream = hashlib.pbkdf2_hmac("sha256", key, nonce, 1, dklen=len(raw))
        ct = bytes(a ^ b for a, b in zip(raw, stream))
        mac = hmac.new(key, nonce + ct, hashlib.sha256).digest()
        return b"XSTR" + nonce + mac + ct

def decrypt_secret(blob: bytes | None) -> dict:
    if not blob:
        return {}
    key = _derive_key()
    try:
        if blob[:4] == b"AGCM":
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            return json.loads(AESGCM(key).decrypt(blob[4:16], bytes(blob[16:]), None))
        if blob[:4] == b"XSTR":
            nonce, mac, ct = blob[4:20], blob[20:52], blob[52:]
            if not hmac.compare_digest(mac, hmac.new(key, nonce + ct, hashlib.sha256).digest()):
                return {}
            stream = hashlib.pbkdf2_hmac("sha256", key, nonce, 1, dklen=len(ct))
            return json.loads(bytes(a ^ b for a, b in zip(ct, stream)))
    except Exception:
        return {}
    return {}


SECRET_MASK = "••••••••"

def redact(text: str, secrets: list[str]) -> str:
    """Redaction at capture point (NFR-SEC-03) — never store an unredacted copy."""
    for s in secrets:
        if s and len(s) > 3:
            text = text.replace(s, SECRET_MASK)
    return text
