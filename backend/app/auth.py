from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from backend.app.settings import OperatorCredential

COOKIE_NAME = "support_session"
SESSION_SECONDS = 8 * 60 * 60
UNKNOWN_TOKEN = "0" * 43


@dataclass(frozen=True)
class SignedSession:
    session_hash: str
    expires_at_ms: int


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def credential_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login_attempt_key(ip: str, operator_id: str, secret: str) -> str:
    value = f"{ip}\0{operator_id.lower()}".encode()
    return hmac.new(secret.encode(), value, hashlib.sha256).hexdigest()


def authenticate_operator(
    operator_id: str,
    token: str,
    credentials: list[OperatorCredential],
) -> dict[str, str] | None:
    credential = next((item for item in credentials if item.id == operator_id), None)
    expected = credential.token if credential else UNKNOWN_TOKEN
    matches = hmac.compare_digest(credential_fingerprint(expected), credential_fingerprint(token))
    if not credential or not matches:
        return None
    return {"id": credential.id, "role": credential.role}


def issue_session(credential: OperatorCredential, secret: str, secure: bool) -> dict[str, str]:
    session_id = _b64(secrets.token_bytes(32))
    expires_at_ms = int((time.time() + SESSION_SECONDS) * 1000)
    data = json.dumps({"sid": session_id, "exp": expires_at_ms}, separators=(",", ":"))
    payload = _b64(data.encode())
    signature = _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    cookie = (
        f"{COOKIE_NAME}={payload}.{signature}; HttpOnly; SameSite=Strict; Path=/; "
        f"Max-Age={SESSION_SECONDS}{'; Secure' if secure else ''}"
    )
    return {
        "cookie": cookie,
        "sessionHash": hashlib.sha256(session_id.encode()).hexdigest(),
        "operatorId": credential.id,
        "credentialHash": credential_fingerprint(credential.token),
        "expiresAt": datetime.fromtimestamp(expires_at_ms / 1000, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
    }


def clear_session_cookie(secure: bool) -> str:
    secure_flag = "; Secure" if secure else ""
    return f"{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure_flag}"


def read_session(cookie_header: str | None, secret: str) -> SignedSession | None:
    prefix = f"{COOKIE_NAME}="
    raw = next(
        (
            part.strip()[len(prefix) :]
            for part in (cookie_header or "").split(";")
            if part.strip().startswith(prefix)
        ),
        None,
    )
    if not raw:
        return None
    pieces = raw.split(".")
    if len(pieces) != 2 or not all(pieces):
        return None
    payload, signature = pieces
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    try:
        received = _unb64(signature)
        body = json.loads(_unb64(payload))
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    if not hmac.compare_digest(expected, received):
        return None
    session_id = body.get("sid")
    expires = body.get("exp")
    now_ms = int(time.time() * 1000)
    if not isinstance(session_id, str) or len(session_id) != 43:
        return None
    latest_allowed = now_ms + SESSION_SECONDS * 1000 + 60_000
    if not isinstance(expires, int) or expires <= now_ms or expires > latest_allowed:
        return None
    return SignedSession(hashlib.sha256(session_id.encode()).hexdigest(), expires)
