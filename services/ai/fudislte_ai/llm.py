"""Model backends: chat (JSON answers) and embeddings, over Ollama or an OpenAI-compatible
server (vLLM, llama.cpp server, LocalAI, or a hosted API when explicitly allowed).

Both are plain HTTP calls with httpx; no vendor SDK is used.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Protocol

import httpx

from .config import Settings

Message = dict[str, str]  # {"role": "system" | "user" | "assistant", "content": str}

_EMBED_BATCH = 32
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


class LLMError(Exception):
    """The model server could not be reached or answered with an error."""

    code = "llm_unavailable"


class LLMOutputError(LLMError):
    """The model answered, but not with the JSON object that was asked for."""

    code = "llm_invalid_output"


class ChatModel(Protocol):
    model: str

    async def chat_json(self, messages: list[Message]) -> dict[str, Any]: ...


class Embedder(Protocol):
    model: str
    dim: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


def parse_json_object(text: str) -> dict[str, Any]:
    """Extracts one JSON object from a model answer (tolerates code fences and think blocks)."""
    if not isinstance(text, str):
        raise LLMOutputError("the model answer is not text")
    cleaned = _THINK.sub("", text).strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.removeprefix("json").strip()
    try:
        value = json.loads(cleaned)
    except ValueError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            raise LLMOutputError("the model did not answer with JSON") from None
        try:
            value = json.loads(cleaned[start : end + 1])
        except ValueError:
            raise LLMOutputError("the model did not answer with valid JSON") from None
    if not isinstance(value, dict):
        raise LLMOutputError("the model answer is not a JSON object")
    return value


class _Backend:
    def __init__(
        self,
        http: httpx.AsyncClient,
        base_url: str,
        api_key: str,
        timeout: float,
        slots: asyncio.Semaphore | None = None,
    ) -> None:
        self.http = http
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        # Shared by every backend of the worker: at most this many model requests at once,
        # so a burst queues here instead of piling onto the model server.
        self.slots = slots

    async def _post(self, path: str, payload: dict[str, Any]) -> Any:
        if self.slots is None:
            return await self._send(path, payload)
        try:
            await asyncio.wait_for(self.slots.acquire(), self.timeout)
        except TimeoutError:
            raise LLMError("model server busy: no free request slot") from None
        try:
            return await self._send(path, payload)
        finally:
            self.slots.release()

    async def _send(self, path: str, payload: dict[str, Any]) -> Any:
        try:
            response = await self.http.post(
                self.base_url + path, json=payload, headers=self.headers, timeout=self.timeout
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"model server unreachable ({type(exc).__name__})") from None
        if response.status_code != 200:
            raise LLMError(f"model server answered HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError:
            raise LLMOutputError("model server answered with invalid JSON") from None


class OllamaChat(_Backend):
    def __init__(
        self,
        http: httpx.AsyncClient,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 120.0,
        slots: asyncio.Semaphore | None = None,
    ):
        super().__init__(http, base_url, api_key, timeout, slots)
        self.model = model

    async def chat_json(self, messages: list[Message]) -> dict[str, Any]:
        data = await self._post(
            "/api/chat",
            {
                "model": self.model,
                "messages": messages,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0},
            },
        )
        content = data.get("message", {}).get("content") if isinstance(data, dict) else None
        return parse_json_object(content)


class OpenAIChat(_Backend):
    """OpenAI-compatible /chat/completions; the URL is the API base, e.g. http://vllm:8000/v1."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 120.0,
        slots: asyncio.Semaphore | None = None,
    ):
        super().__init__(http, base_url, api_key, timeout, slots)
        self.model = model

    async def chat_json(self, messages: list[Message]) -> dict[str, Any]:
        data = await self._post(
            "/chat/completions",
            {
                "model": self.model,
                "messages": messages,
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
        )
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise LLMOutputError("model server answered without a message") from None
        return parse_json_object(content)


class _EmbedderBase(_Backend):
    def __init__(
        self,
        http: httpx.AsyncClient,
        base_url: str,
        model: str,
        dim: int,
        api_key: str = "",
        timeout: float = 120.0,
        slots: asyncio.Semaphore | None = None,
    ):
        super().__init__(http, base_url, api_key, timeout, slots)
        self.model = model
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), _EMBED_BATCH):
            batch = texts[start : start + _EMBED_BATCH]
            got = await self._embed_batch(batch)
            if len(got) != len(batch):
                raise LLMOutputError("model server returned the wrong number of embeddings")
            for vector in got:
                if not isinstance(vector, list) or len(vector) != self.dim:
                    size = len(vector) if isinstance(vector, list) else "no"
                    raise LLMOutputError(
                        f"embedding has {size} dimensions but FUDISLTE_AI_EMBED_DIM is {self.dim}"
                    )
                vectors.append([float(x) for x in vector])
        return vectors

    async def _embed_batch(self, texts: list[str]) -> list[Any]:
        raise NotImplementedError


class OllamaEmbedder(_EmbedderBase):
    async def _embed_batch(self, texts: list[str]) -> list[Any]:
        data = await self._post("/api/embed", {"model": self.model, "input": texts})
        if not isinstance(data, dict) or not isinstance(data.get("embeddings"), list):
            raise LLMOutputError("model server answered without embeddings")
        return data["embeddings"]


class OpenAIEmbedder(_EmbedderBase):
    async def _embed_batch(self, texts: list[str]) -> list[Any]:
        data = await self._post("/embeddings", {"model": self.model, "input": texts})
        try:
            rows = sorted(data["data"], key=lambda row: row["index"])
            return [row["embedding"] for row in rows]
        except (KeyError, TypeError):
            raise LLMOutputError("model server answered without embeddings") from None


def build_chat(settings: Settings, http: httpx.AsyncClient, slots: asyncio.Semaphore | None = None) -> ChatModel | None:
    if not settings.chat_configured:
        return None
    cls = OllamaChat if settings.llm_kind == "ollama" else OpenAIChat
    return cls(http, settings.llm_url, settings.llm_model, settings.llm_api_key, settings.llm_timeout_seconds, slots)


def build_embedder(settings: Settings, http: httpx.AsyncClient, slots: asyncio.Semaphore | None = None) -> Embedder | None:
    if not settings.embeddings_configured:
        return None
    cls = OllamaEmbedder if settings.llm_kind == "ollama" else OpenAIEmbedder
    return cls(
        http,
        settings.embed_url or settings.llm_url,
        settings.embed_model,
        settings.embed_dim,
        settings.llm_api_key,
        settings.llm_timeout_seconds,
        slots,
    )
