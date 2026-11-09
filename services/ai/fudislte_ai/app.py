"""HTTP application: routes, error handling and wiring (docs/architecture/ai-worker.md)."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import logging
import os
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__
from .agents.catalog import default_registry
from .agents.client import HttpFudislteClient, FudislteClient
from .agents.runner import AgentRunner, Run, RunStore
from .agents.schemas import ApproveRequest, RejectRequest, StartRunRequest
from .auth import SignatureMiddleware
from .chunking import chunk_text
from .config import Settings
from .errors import ApiError, capability_disabled, error_body
from .grounded import suggest_tasks, summarize
from .llm import ChatModel, Embedder, LLMError, build_chat, build_embedder
from .schemas import (
    DeleteIndexRequest,
    DeleteIndexResponse,
    IndexRequest,
    IndexResponse,
    SearchRequest,
    SearchResponse,
    SearchResult,
    SuggestTasksRequest,
    SuggestTasksResponse,
    SummarizeRequest,
    SummarizeResponse,
    TranscribeResponse,
)
from .store import PgVectorStore
from .transcribe import (
    Transcriber,
    TranscriptionError,
    TranscriptionModelError,
    WhisperTranscriber,
    whisper_installed,
)

log = logging.getLogger("fudislte_ai")
T = TypeVar("T")


@dataclasses.dataclass
class Services:
    chat: ChatModel | None = None
    embedder: Embedder | None = None
    store: PgVectorStore | None = None
    transcriber: Transcriber | None = None
    runner: AgentRunner | None = None


def create_app(
    settings: Settings,
    *,
    chat: ChatModel | None = None,
    embedder: Embedder | None = None,
    store: PgVectorStore | None = None,
    transcriber: Transcriber | None = None,
    client_factory: Callable[[Run], FudislteClient] | None = None,
    clock: Callable[[], float] = time.time,
) -> FastAPI:
    """Builds the app. Tests inject fakes; production builds everything from settings."""
    services = Services()
    registry = default_registry()
    runs = RunStore(settings.run_ttl_seconds, settings.max_runs)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        llm_http = httpx.AsyncClient(timeout=settings.llm_timeout_seconds)
        # Calls back to the FUDISLTE API: no proxies from the environment, no redirects.
        api_http = httpx.AsyncClient(trust_env=False, follow_redirects=False)
        llm_slots = asyncio.Semaphore(settings.llm_concurrency)
        services.chat = chat if chat is not None else build_chat(settings, llm_http, llm_slots)
        services.embedder = embedder if embedder is not None else build_embedder(settings, llm_http, llm_slots)
        vector_store = store
        if vector_store is None and services.embedder is not None:
            vector_store = PgVectorStore(settings.database_url, settings.embed_model, settings.embed_dim)
        if vector_store is not None:
            try:
                await vector_store.open()
                services.store = vector_store
            except Exception as exc:  # retrieval is optional: keep serving the rest
                log.error("retrieval disabled: %s", exc)
        services.transcriber = transcriber if transcriber is not None else _build_transcriber(settings)
        if services.chat is not None:
            factory = client_factory or (
                lambda run: HttpFudislteClient(
                    api_http,
                    base_url=settings.api_url,
                    secret=settings.shared_secret,
                    token=run.token or "",
                    run_id=run.id,
                    org_id=run.org_id,
                    user_id=run.user_id,
                    agent=run.agent,
                )
            )
            services.runner = AgentRunner(services.chat, registry, runs, factory)
        _log_capabilities(settings, services)
        sweeper = asyncio.create_task(_sweep(runs))
        try:
            yield
        finally:
            sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sweeper
            if services.store is not None:
                await services.store.close()
            await llm_http.aclose()
            await api_http.aclose()
            services.chat = services.embedder = services.store = services.transcriber = services.runner = None

    app = FastAPI(
        title="FUDISLTE AI worker",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(
        SignatureMiddleware,
        secret=settings.shared_secret,
        max_body_bytes=settings.max_body_bytes,
        large_body_paths={"/v1/transcribe": settings.max_audio_bytes},
        clock=clock,
    )

    @app.exception_handler(ApiError)
    async def _api_error(_, exc: ApiError) -> JSONResponse:
        return JSONResponse(exc.body(), status_code=exc.status)

    @app.exception_handler(LLMError)
    async def _llm_error(_, exc: LLMError) -> JSONResponse:
        return JSONResponse(error_body(exc.code, str(exc)), status_code=502)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_, exc: RequestValidationError) -> JSONResponse:
        fields: dict[str, str] = {}
        for err in exc.errors()[:20]:
            loc = [str(p) for p in err.get("loc", ()) if p != "body"]
            fields[".".join(loc) or "body"] = str(err.get("msg", "invalid"))
        return JSONResponse(error_body("validation_failed", "Some fields are invalid.", fields), status_code=422)

    @app.exception_handler(Exception)
    async def _internal(_, exc: Exception) -> JSONResponse:
        log.error("request failed: %s", type(exc).__name__, exc_info=exc)
        return JSONResponse(error_body("internal_error", "Something went wrong."), status_code=500)

    def require_chat() -> ChatModel:
        if services.chat is None:
            raise capability_disabled("llm")
        return services.chat

    def require_retrieval() -> tuple[PgVectorStore, Embedder]:
        if services.store is None or services.embedder is None:
            raise capability_disabled("embeddings")
        return services.store, services.embedder

    def require_runner() -> AgentRunner:
        if services.runner is None:
            raise capability_disabled("llm")
        return services.runner

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": __version__,
            "capabilities": {
                "llm": services.chat is not None,
                "embeddings": services.store is not None and services.embedder is not None,
                "transcription": services.transcriber is not None,
            },
            "llm": {
                "kind": settings.llm_kind,
                "external": settings.llm_external,
            },
        }

    @app.post("/v1/summarize", response_model=SummarizeResponse)
    async def summarize_route(req: SummarizeRequest) -> SummarizeResponse:
        return await summarize(require_chat(), req)

    @app.post("/v1/suggest-tasks", response_model=SuggestTasksResponse)
    async def suggest_route(req: SuggestTasksRequest) -> SuggestTasksResponse:
        return await suggest_tasks(require_chat(), req)

    @app.post("/v1/index", response_model=IndexResponse)
    async def index_route(req: IndexRequest) -> IndexResponse:
        vector_store, embed = require_retrieval()
        if await vector_store.is_stale(req.org_id, req.source_type, req.source_id, req.updated_at):
            return IndexResponse(status="stale", chunks=0)
        chunks = chunk_text(req.text) or [req.title.strip()]
        title = req.title.strip()
        vectors = await embed.embed([f"{title}\n\n{c}" if title and c != title else c for c in chunks])
        status, count = await vector_store.replace(
            org_id=req.org_id,
            source_type=req.source_type,
            source_id=req.source_id,
            acl_id=req.acl_id,
            title=title,
            updated_at=req.updated_at,
            chunks=chunks,
            embeddings=vectors,
        )
        return IndexResponse(status=status, chunks=count)

    @app.delete("/v1/index", response_model=DeleteIndexResponse)
    async def delete_index_route(req: DeleteIndexRequest) -> DeleteIndexResponse:
        if services.store is None:
            raise capability_disabled("embeddings")
        deleted = await services.store.delete(req.org_id, req.source_type, req.source_id)
        return DeleteIndexResponse(deleted=deleted)

    @app.post("/v1/search", response_model=SearchResponse)
    async def search_route(req: SearchRequest) -> SearchResponse:
        vector_store, embed = require_retrieval()
        if not req.allowed_acl_ids:
            return SearchResponse(results=[])
        [vector] = await embed.embed([req.query])
        hits = await vector_store.search(req.org_id, vector, req.allowed_acl_ids, req.limit)
        return SearchResponse(results=[SearchResult(**dataclasses.asdict(hit)) for hit in hits])

    @app.post("/v1/transcribe", response_model=TranscribeResponse)
    async def transcribe_route(audio: UploadFile = File(...), language: str | None = Form(None)) -> TranscribeResponse:
        if services.transcriber is None:
            raise capability_disabled("transcription")
        if language not in (None, "", "tr", "en"):
            raise ApiError(422, "validation_failed", "Some fields are invalid.", {"language": "must be tr or en"})
        # Decode straight from the upload's spooled file: copying it to a named file
        # first would hold the audio a third time (it is already in the signature
        # check's spool and in the upload).
        upload = audio.file
        upload.seek(0, os.SEEK_END)
        if upload.tell() == 0:
            raise ApiError(422, "audio_unreadable", "The audio file is empty.")
        upload.seek(0)
        try:
            return await services.transcriber.transcribe(upload, language or None)
        except TranscriptionError:
            raise ApiError(422, "audio_unreadable", "The audio could not be decoded.") from None
        except TranscriptionModelError:
            raise ApiError(503, "model_unavailable", "The speech-to-text model could not be loaded.") from None

    @app.get("/v1/agents")
    async def agents_route() -> dict[str, Any]:
        return registry.catalog()

    @app.post("/v1/agents/runs", status_code=201)
    async def start_run_route(req: StartRunRequest) -> dict[str, Any]:
        run = await _shielded(require_runner().start(req))
        return run.public()

    @app.get("/v1/agents/runs/{run_id}")
    async def get_run_route(run_id: str) -> dict[str, Any]:
        return runs.get(run_id).public()

    @app.post("/v1/agents/runs/{run_id}/approve")
    async def approve_route(run_id: str, req: ApproveRequest) -> dict[str, Any]:
        run = await _shielded(require_runner().approve(run_id, req))
        return run.public()

    @app.post("/v1/agents/runs/{run_id}/reject")
    async def reject_route(run_id: str, req: RejectRequest) -> dict[str, Any]:
        run = await _shielded(require_runner().reject(run_id, req))
        return run.public()

    app.state.services = services
    app.state.runs = runs
    return app


async def _shielded(work: Awaitable[T]) -> T:
    """Runs agent work to its next stopping point even if the caller disconnects;
    the API can then read the outcome with GET /v1/agents/runs/{id}."""
    task = asyncio.ensure_future(work)
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    return await asyncio.shield(task)


async def _sweep(runs: RunStore) -> None:
    while True:
        await asyncio.sleep(60)
        runs.sweep()


def _build_transcriber(settings: Settings) -> Transcriber | None:
    if not settings.transcription_configured:
        return None
    if not whisper_installed():
        log.warning(
            "FUDISLTE_AI_WHISPER_MODEL is set but faster-whisper is not installed; transcription stays "
            "disabled (build the image with --build-arg WITH_WHISPER=true)"
        )
        return None
    return WhisperTranscriber(
        settings.whisper_model, settings.whisper_device, settings.whisper_compute_type, settings.model_dir
    )


def _log_capabilities(settings: Settings, services: Services) -> None:
    log.info(
        "capabilities: llm=%s embeddings=%s transcription=%s",
        services.chat is not None,
        services.store is not None and services.embedder is not None,
        services.transcriber is not None,
    )
    if settings.llm_external:
        log.warning(
            "FUDISLTE_AI_LLM_URL (%s) is outside this server: prompts with workspace content leave it",
            urlsplit(settings.llm_url).hostname,
        )
