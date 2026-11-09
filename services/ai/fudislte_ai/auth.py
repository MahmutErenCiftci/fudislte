"""Request signing between the FUDISLTE API and the AI worker.

Every request except `GET /healthz` carries

    X-FUDISLTE-Timestamp: <unix seconds>
    X-FUDISLTE-Signature: v1=<hex HMAC-SHA256(secret, signed string)>

    signed string = timestamp + "." + METHOD + "." + request target + "." + raw body

where METHOD is the uppercase HTTP method and the request target is the raw path exactly
as sent plus "?" and the query string when there is one (no scheme or host), e.g.
`1767225600.POST./v1/summarize.{"hello":"world"}`. The worker rejects timestamps more
than 300 seconds away from its clock and compares signatures in constant time. The body
is verified before any route sees it. The same scheme signs the worker's own calls back
to the API (agent tools).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import tempfile
import time
from collections.abc import Callable, Iterable

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .errors import error_body

TIMESTAMP_HEADER = "X-FUDISLTE-Timestamp"
SIGNATURE_HEADER = "X-FUDISLTE-Signature"
SIGNATURE_VERSION = "v1"
MAX_SKEW_SECONDS = 300
_SPOOL_IN_MEMORY = 1 << 20
_REPLAY_CHUNK = 64 << 10


def _ascii(value: str | bytes) -> bytes:
    return value if isinstance(value, bytes) else value.encode("ascii")


def signed_prefix(timestamp: str, method: str, target: str | bytes) -> bytes:
    """Everything the MAC covers before the body: `timestamp.METHOD.target.`"""
    return b".".join((_ascii(timestamp), _ascii(method.upper()), _ascii(target))) + b"."


def compute_signature(secret: bytes, timestamp: str, method: str, target: str | bytes, body: bytes) -> str:
    mac = hmac.new(secret, signed_prefix(timestamp, method, target) + body, hashlib.sha256)
    return f"{SIGNATURE_VERSION}={mac.hexdigest()}"


def sign_headers(secret: bytes, method: str, target: str | bytes, body: bytes, now: float | None = None) -> dict[str, str]:
    """Headers that authenticate one request: method, request target and body."""
    timestamp = str(int(time.time() if now is None else now))
    return {TIMESTAMP_HEADER: timestamp, SIGNATURE_HEADER: compute_signature(secret, timestamp, method, target, body)}


def request_target(scope: Scope) -> bytes:
    """The request target as received: raw path, plus "?query" when there is one."""
    raw_path = scope.get("raw_path") or scope["path"].encode("utf-8")
    query = scope.get("query_string") or b""
    return raw_path + b"?" + query if query else raw_path


class SignatureMiddleware:
    """ASGI middleware that authenticates every request except the exempt ones.

    The raw body is read (spooled to a temporary file above 1 MiB, never more than the
    size limit), the HMAC is checked, and only then is the body replayed to the app.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        secret: bytes,
        max_body_bytes: int,
        large_body_paths: dict[str, int] | None = None,
        exempt: Iterable[tuple[str, str]] = (("GET", "/healthz"),),
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.app = app
        self.secret = secret
        self.max_body_bytes = max_body_bytes
        self.large_body_paths = large_body_paths or {}
        self.exempt = frozenset(exempt)
        self.clock = clock

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or (scope["method"], scope["path"]) in self.exempt:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        timestamp = headers.get(TIMESTAMP_HEADER, "")
        signature = headers.get(SIGNATURE_HEADER, "").strip()
        if not timestamp or not signature:
            await _reject(send, 401, "signature_missing", "X-FUDISLTE-Timestamp and X-FUDISLTE-Signature are required.")
            return
        if not (timestamp.isascii() and timestamp.isdigit() and len(timestamp) <= 12):
            await _reject(send, 401, "timestamp_invalid", "X-FUDISLTE-Timestamp must be Unix time in seconds.")
            return
        if abs(self.clock() - int(timestamp)) > MAX_SKEW_SECONDS:
            await _reject(send, 401, "timestamp_expired", "X-FUDISLTE-Timestamp is more than 300 seconds off.")
            return

        limit = self.large_body_paths.get(scope["path"], self.max_body_bytes)
        declared = headers.get("content-length", "")
        if declared.isdigit() and int(declared) > limit:
            await _reject(send, 413, "body_too_large", "Request body is too large.")
            return

        prefix = signed_prefix(timestamp, scope["method"], request_target(scope))
        mac = hmac.new(self.secret, prefix, hashlib.sha256)
        spool = tempfile.SpooledTemporaryFile(max_size=_SPOOL_IN_MEMORY)
        try:
            size = 0
            more = True
            while more:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                more = message.get("more_body", False)
                size += len(chunk)
                if size > limit:
                    await _reject(send, 413, "body_too_large", "Request body is too large.")
                    return
                mac.update(chunk)
                spool.write(chunk)

            expected = f"{SIGNATURE_VERSION}={mac.hexdigest()}".encode("ascii")
            if not hmac.compare_digest(expected, signature.encode("latin-1")):
                await _reject(send, 401, "signature_invalid", "The request signature is not valid.")
                return

            spool.seek(0)
            replay_done = False

            async def replay() -> Message:
                nonlocal replay_done
                if replay_done:
                    return await receive()
                chunk = spool.read(_REPLAY_CHUNK)
                rest = spool.read(1)
                if rest:
                    spool.seek(-1, 1)
                else:
                    replay_done = True
                return {"type": "http.request", "body": chunk, "more_body": not replay_done}

            await self.app(scope, replay, send)
        finally:
            spool.close()


async def _reject(send: Send, status: int, code: str, message: str) -> None:
    body = json.dumps(error_body(code, message)).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
