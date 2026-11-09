"""Backend wire formats against mocked HTTP (no model server), JSON parsing, chunking."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from fudislte_ai.chunking import chunk_text
from fudislte_ai.llm import (
    LLMError,
    LLMOutputError,
    OllamaChat,
    OllamaEmbedder,
    OpenAIChat,
    OpenAIEmbedder,
    parse_json_object,
)


def mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_ollama_chat_and_embed_requests() -> None:
    seen: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((request.url.path, body))
        if request.url.path == "/api/chat":
            return httpx.Response(200, json={"message": {"role": "assistant", "content": '{"summary": "ok"}'}})
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3]] * len(body["input"])})

    async def scenario():
        async with mock_client(handler) as http:
            chat = OllamaChat(http, "http://ollama:11434", "qwen2.5:7b-instruct")
            reply = await chat.chat_json([{"role": "user", "content": "hi"}])
            vectors = await OllamaEmbedder(http, "http://ollama:11434", "nomic-embed-text", 3).embed(["a", "b"])
            return reply, vectors

    reply, vectors = asyncio.run(scenario())
    assert reply == {"summary": "ok"} and vectors == [[0.1, 0.2, 0.3]] * 2
    path, body = seen[0]
    assert path == "/api/chat" and body["format"] == "json" and body["stream"] is False
    assert body["options"] == {"temperature": 0} and body["model"] == "qwen2.5:7b-instruct"
    assert seen[1] == ("/api/embed", {"model": "nomic-embed-text", "input": ["a", "b"]})


def test_openai_compatible_requests_and_api_key() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(200, json={"choices": [{"message": {"content": '```json\n{"a": 1}\n```'}}]})
        return httpx.Response(200, json={"data": [{"index": 1, "embedding": [2.0, 2.0]}, {"index": 0, "embedding": [1.0, 1.0]}]})

    async def scenario():
        async with mock_client(handler) as http:
            chat = OpenAIChat(http, "http://vllm:8000/v1", "model-x", api_key="k-123")
            reply = await chat.chat_json([{"role": "user", "content": "hi"}])
            vectors = await OpenAIEmbedder(http, "http://vllm:8000/v1", "embed-x", 2).embed(["first", "second"])
            return reply, vectors

    reply, vectors = asyncio.run(scenario())
    assert reply == {"a": 1}
    assert vectors == [[1.0, 1.0], [2.0, 2.0]]  # ordered by index
    body = json.loads(seen[0].content)
    assert body["response_format"] == {"type": "json_object"} and body["temperature"] == 0
    assert seen[0].headers["Authorization"] == "Bearer k-123"


def test_backend_failures() -> None:
    async def scenario(handler, dim=3):
        async with mock_client(handler) as http:
            return await OllamaEmbedder(http, "http://ollama:11434", "m", dim).embed(["a"])

    with pytest.raises(LLMError, match="HTTP 500"):
        asyncio.run(scenario(lambda r: httpx.Response(500)))
    with pytest.raises(LLMOutputError, match="FUDISLTE_AI_EMBED_DIM"):
        asyncio.run(scenario(lambda r: httpx.Response(200, json={"embeddings": [[1.0, 2.0]]})))

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(LLMError, match="unreachable"):
        asyncio.run(scenario(refuse))


def test_parse_json_object() -> None:
    assert parse_json_object('{"a": 1}') == {"a": 1}
    assert parse_json_object('<think>hmm {"x"}</think>\n{"a": 2}') == {"a": 2}
    assert parse_json_object('Sure! Here it is: {"a": 3} Hope it helps.') == {"a": 3}
    for bad in ("no json here", "[1, 2]", '{"a": '):
        with pytest.raises(LLMOutputError):
            parse_json_object(bad)


def test_chunk_text() -> None:
    assert chunk_text("") == []
    assert chunk_text("  short text  ") == ["short text"]
    text = " ".join(f"Sentence number {i} is here." for i in range(400))
    chunks = chunk_text(text, max_chars=500, overlap=80)
    assert len(chunks) > 10
    assert all(len(c) <= 500 for c in chunks)
    # Chunks start at word boundaries and together cover the whole text.
    assert all(not c[0].isspace() for c in chunks)
    assert chunks[0].startswith("Sentence number 0") and chunks[-1].endswith("399 is here.")
    giant = "x" * 5000
    assert "".join(chunk_text(giant, max_chars=1000, overlap=100)).count("x") >= 5000


def test_shared_slots_bound_concurrent_model_requests() -> None:
    active = peak = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return httpx.Response(200, json={"message": {"content": '{"ok": true}'}})

    async def scenario() -> None:
        slots = asyncio.Semaphore(2)
        async with mock_client(handler) as http:
            chat = OllamaChat(http, "http://ollama:11434", "m", slots=slots)
            await asyncio.gather(*(chat.chat_json([{"role": "user", "content": "hi"}]) for _ in range(6)))
            # A request that cannot get a slot within the timeout fails instead of waiting forever.
            busy = OllamaChat(http, "http://ollama:11434", "m", timeout=0.05, slots=asyncio.Semaphore(0))
            with pytest.raises(LLMError, match="busy"):
                await busy.chat_json([{"role": "user", "content": "hi"}])

    asyncio.run(scenario())
    assert peak == 2
