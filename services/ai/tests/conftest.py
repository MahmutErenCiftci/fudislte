"""Shared fakes and helpers. No test talks to a real model server."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from fudislte_ai.app import create_app
from fudislte_ai.auth import sign_headers
from fudislte_ai.config import Settings

SECRET = b"test-secret-0123456789abcdef-0123456789"
TEST_DSN = os.environ.get("FUDISLTE_AI_TEST_DATABASE_URL", "")


def make_settings(**overrides: Any) -> Settings:
    return Settings(shared_secret=SECRET, **overrides)


class FakeChat:
    """Returns scripted replies (dicts, callables or exceptions) and records every call."""

    model = "fake-model"

    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.calls: list[list[dict[str, str]]] = []

    async def chat_json(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        self.calls.append([dict(m) for m in messages])
        if not self.replies:
            raise AssertionError("unexpected model call")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(messages)
            if hasattr(reply, "__await__"):
                reply = await reply
        return reply


class FakeEmbedder:
    """Deterministic bag-of-words vectors: texts sharing words are close."""

    model = "fake-embed"
    dim = 16

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [embed_text(t, self.dim) for t in texts]


def embed_text(text: str, dim: int = 16) -> list[float]:
    vec = [0.0] * dim
    vec[0] = 0.05  # never a zero vector
    for word in re.findall(r"\w+", text.lower()):
        digest = hashlib.sha256(word.encode()).digest()
        vec[digest[0] % dim] += 1.0 if digest[1] % 2 else -1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec]


class Signed:
    """Sends requests signed like the FUDISLTE API does: over the method, the request
    target exactly as sent and the body. `sign_as=(method, target)` signs a different
    request than the one sent, to test replays."""

    def __init__(self, client: TestClient, secret: bytes = SECRET) -> None:
        self.client = client
        self.secret = secret

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        now: float | None = None,
        sign_as: tuple[str, str] | None = None,
    ) -> Any:
        raw = b"" if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"} if body is not None else {}
        request = self.client.build_request(method, path, content=raw, headers=headers)
        return self._send_signed(request, raw, now, sign_as)

    def post(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.request("POST", path, body, **kw)

    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, None, **kw)

    def delete(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.request("DELETE", path, body, **kw)

    def multipart(self, path: str, files: dict[str, Any], data: dict[str, str] | None = None) -> Any:
        request = self.client.build_request("POST", path, files=files, data=data or {})
        return self._send_signed(request, request.read(), None, None)

    def _send_signed(self, request: Any, raw: bytes, now: float | None, sign_as: tuple[str, str] | None) -> Any:
        method, target = sign_as or (request.method, request.url.raw_path.decode("ascii"))
        request.headers.update(sign_headers(self.secret, method, target, raw, now))
        return self.client.send(request)


@contextmanager
def running(settings: Settings | None = None, **injected: Any) -> Iterator[Signed]:
    app = create_app(settings or make_settings(), **injected)
    with TestClient(app) as client:
        signed = Signed(client)
        signed.app = app
        yield signed


@pytest.fixture
def worker() -> Callable[..., Any]:
    return running


def error_code(response: Any) -> str:
    return response.json()["error"]["code"]
