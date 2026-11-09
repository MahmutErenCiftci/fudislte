"""Configuration from environment variables (docs/architecture/ai-worker.md)."""

from __future__ import annotations

import ipaddress
import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

MIN_SECRET_LENGTH = 32
LLM_KINDS = ("ollama", "openai", "none")
# pgvector's HNSW index supports up to 2000 dimensions for the `vector` type.
MAX_EMBED_DIM = 2000


class ConfigError(ValueError):
    """Every problem found in the environment, one per line."""


@dataclass(frozen=True)
class Settings:
    shared_secret: bytes
    http_host: str = "0.0.0.0"
    http_port: int = 8090
    llm_kind: str = "none"
    llm_url: str = ""
    llm_model: str = ""
    llm_api_key: str = ""
    llm_timeout_seconds: float = 120.0
    # Model requests in flight at once, across chat and embeddings.
    llm_concurrency: int = 4
    allow_external_llm: bool = False
    embed_model: str = ""
    # Empty: the embedding model is served at llm_url too (Ollama serves both).
    embed_url: str = ""
    embed_dim: int = 768
    database_url: str = ""
    whisper_model: str = ""
    whisper_device: str = "auto"
    whisper_compute_type: str = "default"
    model_dir: str = ""
    api_url: str = "http://api:8080"
    max_body_bytes: int = 8 << 20
    max_audio_bytes: int = 100 << 20
    run_ttl_seconds: int = 24 * 3600
    max_runs: int = 200
    log_level: str = "info"

    @property
    def chat_configured(self) -> bool:
        return self.llm_kind != "none" and bool(self.llm_model)

    @property
    def embeddings_configured(self) -> bool:
        return self.llm_kind != "none" and bool(self.embed_model) and bool(self.database_url)

    @property
    def transcription_configured(self) -> bool:
        return bool(self.whisper_model)

    @property
    def llm_external(self) -> bool:
        """Whether prompts or texts to embed may leave this server's network."""
        if self.llm_kind == "none":
            return False
        return is_external_url(self.llm_url) or (bool(self.embed_url) and is_external_url(self.embed_url))


def is_external_url(url: str) -> bool:
    """Reports whether a model server URL may be outside this server's private network.

    Loopback and private addresses, single-label names (Compose service names such as
    `ollama`) and reserved private suffixes count as local; any other host name or a
    public address counts as external, because prompts would leave the network.
    """
    host = (urlsplit(url).hostname or "").lower()
    if not host:
        return False
    if host == "localhost" or host.endswith((".localhost", ".internal", ".local", ".lan", ".home.arpa")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "." in host
    return not (ip.is_private or ip.is_loopback or ip.is_link_local)


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    errors: list[str] = []

    def get(name: str, default: str = "") -> str:
        value = env.get(name, "")
        return value.strip() if value.strip() else default

    def integer(name: str, default: int, low: int, high: int) -> int:
        raw = get(name, str(default))
        try:
            value = int(raw)
        except ValueError:
            errors.append(f"{name} must be a whole number")
            return default
        if not low <= value <= high:
            errors.append(f"{name} must be between {low} and {high}")
            return default
        return value

    def boolean(name: str) -> bool:
        raw = get(name, "false").lower()
        if raw in ("1", "true", "yes"):
            return True
        if raw not in ("0", "false", "no"):
            errors.append(f"{name} must be true or false")
        return False

    secret = env.get("FUDISLTE_AI_SHARED_SECRET", "")
    if len(secret) < MIN_SECRET_LENGTH:
        errors.append(
            f"FUDISLTE_AI_SHARED_SECRET must be at least {MIN_SECRET_LENGTH} characters "
            "(generate one with: openssl rand -hex 32)"
        )

    host, port = "0.0.0.0", 8090
    addr = get("FUDISLTE_AI_HTTP_ADDR", ":8090")
    head, sep, tail = addr.rpartition(":")
    if not sep or not tail.isdigit() or not 0 < int(tail) < 65536:
        errors.append("FUDISLTE_AI_HTTP_ADDR must look like :8090 or 127.0.0.1:8090")
    else:
        host, port = (head.strip("[]") or "0.0.0.0"), int(tail)

    kind = get("FUDISLTE_AI_LLM_KIND", "none").lower()
    if kind not in LLM_KINDS:
        errors.append("FUDISLTE_AI_LLM_KIND must be ollama, openai or none")
        kind = "none"
    llm_url = get("FUDISLTE_AI_LLM_URL").rstrip("/")
    embed_url = get("FUDISLTE_AI_EMBED_URL").rstrip("/")
    llm_model = get("FUDISLTE_AI_LLM_MODEL")
    embed_model = get("FUDISLTE_AI_EMBED_MODEL")
    allow_external = boolean("FUDISLTE_AI_ALLOW_EXTERNAL_LLM")

    def check_model_url(name: str, url: str) -> None:
        if not _valid_http_url(url):
            errors.append(f"{name} must be an http(s):// URL when FUDISLTE_AI_LLM_KIND={kind}")
        elif is_external_url(url):
            if not allow_external:
                errors.append(
                    f"{name} points outside this server's private network; prompts contain "
                    "workspace content. Use a local model server, or set FUDISLTE_AI_ALLOW_EXTERNAL_LLM=true "
                    "to accept that data leaves the server"
                )
            elif urlsplit(url).scheme != "https":
                errors.append(f"An external {name} must use https://")

    if kind != "none":
        check_model_url("FUDISLTE_AI_LLM_URL", llm_url)
        if embed_url:
            check_model_url("FUDISLTE_AI_EMBED_URL", embed_url)
        if not llm_model and not embed_model:
            errors.append(f"FUDISLTE_AI_LLM_MODEL and/or FUDISLTE_AI_EMBED_MODEL is required when FUDISLTE_AI_LLM_KIND={kind}")

    database_url = get("FUDISLTE_AI_DATABASE_URL")
    if embed_model and kind != "none" and not database_url:
        errors.append("FUDISLTE_AI_DATABASE_URL (PostgreSQL with pgvector) is required with FUDISLTE_AI_EMBED_MODEL")
    if database_url and urlsplit(database_url).scheme not in ("postgres", "postgresql"):
        errors.append("FUDISLTE_AI_DATABASE_URL must be a postgres:// URL")

    whisper_device = get("FUDISLTE_AI_WHISPER_DEVICE", "auto").lower()
    if whisper_device not in ("auto", "cpu", "cuda"):
        errors.append("FUDISLTE_AI_WHISPER_DEVICE must be auto, cpu or cuda")

    api_url = get("FUDISLTE_AI_API_URL", "http://api:8080").rstrip("/")
    if not _valid_http_url(api_url):
        errors.append("FUDISLTE_AI_API_URL must be an http(s):// URL")

    log_level = get("FUDISLTE_AI_LOG_LEVEL", "info").lower()
    if log_level not in ("debug", "info", "warning", "error"):
        errors.append("FUDISLTE_AI_LOG_LEVEL must be debug, info, warning or error")

    settings = Settings(
        shared_secret=secret.encode(),
        http_host=host,
        http_port=port,
        llm_kind=kind,
        llm_url=llm_url,
        llm_model=llm_model,
        llm_api_key=get("FUDISLTE_AI_LLM_API_KEY"),
        llm_timeout_seconds=float(integer("FUDISLTE_AI_LLM_TIMEOUT_SECONDS", 120, 5, 3600)),
        llm_concurrency=integer("FUDISLTE_AI_LLM_CONCURRENCY", 4, 1, 64),
        allow_external_llm=allow_external,
        embed_model=embed_model,
        embed_url=embed_url,
        embed_dim=integer("FUDISLTE_AI_EMBED_DIM", 768, 1, MAX_EMBED_DIM),
        database_url=database_url,
        whisper_model=get("FUDISLTE_AI_WHISPER_MODEL"),
        whisper_device=whisper_device,
        whisper_compute_type=get("FUDISLTE_AI_WHISPER_COMPUTE_TYPE", "default"),
        model_dir=get("FUDISLTE_AI_MODEL_DIR"),
        api_url=api_url,
        max_body_bytes=integer("FUDISLTE_AI_MAX_BODY_MB", 8, 1, 64) << 20,
        max_audio_bytes=integer("FUDISLTE_AI_MAX_AUDIO_MB", 100, 1, 2048) << 20,
        run_ttl_seconds=integer("FUDISLTE_AI_RUN_TTL_SECONDS", 24 * 3600, 60, 7 * 24 * 3600),
        max_runs=integer("FUDISLTE_AI_MAX_RUNS", 200, 1, 10000),
        log_level=log_level,
    )
    if errors:
        raise ConfigError("\n".join(errors))
    return settings


def _valid_http_url(url: str) -> bool:
    parts = urlsplit(url)
    return (
        parts.scheme in ("http", "https")
        and bool(parts.hostname)
        and not parts.username
        and not parts.password
        and not parts.query
        and not parts.fragment
    )
