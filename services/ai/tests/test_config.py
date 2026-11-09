from __future__ import annotations

import pytest

from fudislte_ai.config import ConfigError, is_external_url, load_settings

SECRET = "x" * 32


def test_shared_secret_is_required_and_long() -> None:
    with pytest.raises(ConfigError, match="FUDISLTE_AI_SHARED_SECRET"):
        load_settings({})
    with pytest.raises(ConfigError, match="at least 32"):
        load_settings({"FUDISLTE_AI_SHARED_SECRET": "short"})


def test_defaults_disable_every_capability() -> None:
    s = load_settings({"FUDISLTE_AI_SHARED_SECRET": SECRET})
    assert s.llm_kind == "none"
    assert (s.http_host, s.http_port) == ("0.0.0.0", 8090)
    assert not s.chat_configured and not s.embeddings_configured and not s.transcription_configured
    assert s.api_url == "http://api:8080"


def test_llm_needs_url_and_model() -> None:
    with pytest.raises(ConfigError) as err:
        load_settings({"FUDISLTE_AI_SHARED_SECRET": SECRET, "FUDISLTE_AI_LLM_KIND": "ollama"})
    assert "FUDISLTE_AI_LLM_URL" in str(err.value) and "FUDISLTE_AI_LLM_MODEL" in str(err.value)
    with pytest.raises(ConfigError, match="ollama, openai or none"):
        load_settings({"FUDISLTE_AI_SHARED_SECRET": SECRET, "FUDISLTE_AI_LLM_KIND": "magic"})


def test_local_ollama_configuration() -> None:
    s = load_settings(
        {
            "FUDISLTE_AI_SHARED_SECRET": SECRET,
            "FUDISLTE_AI_LLM_KIND": "ollama",
            "FUDISLTE_AI_LLM_URL": "http://ollama:11434/",
            "FUDISLTE_AI_LLM_MODEL": "qwen2.5:7b-instruct",
            "FUDISLTE_AI_EMBED_MODEL": "nomic-embed-text",
            "FUDISLTE_AI_DATABASE_URL": "postgres://fudislte_ai:pw@ai-postgres:5432/fudislte_ai",
            "FUDISLTE_AI_HTTP_ADDR": "127.0.0.1:9000",
        }
    )
    assert s.llm_url == "http://ollama:11434"
    assert s.chat_configured and s.embeddings_configured and not s.llm_external
    assert (s.http_host, s.http_port) == ("127.0.0.1", 9000)


def test_embeddings_need_a_database() -> None:
    with pytest.raises(ConfigError, match="FUDISLTE_AI_DATABASE_URL"):
        load_settings(
            {
                "FUDISLTE_AI_SHARED_SECRET": SECRET,
                "FUDISLTE_AI_LLM_KIND": "ollama",
                "FUDISLTE_AI_LLM_URL": "http://ollama:11434",
                "FUDISLTE_AI_EMBED_MODEL": "nomic-embed-text",
            }
        )


@pytest.mark.parametrize(
    ("url", "external"),
    [
        ("http://ollama:11434", False),
        ("http://localhost:11434", False),
        ("http://127.0.0.1:8000/v1", False),
        ("http://10.1.2.3:8000/v1", False),
        ("http://192.168.1.20:11434", False),
        ("http://gpu.internal:8000/v1", False),
        ("http://[::1]:8000/v1", False),
        ("https://api.example.com/v1", True),
        ("http://8.8.8.8:8000/v1", True),
        ("https://gpu.company.com/v1", True),
    ],
)
def test_external_url_detection(url: str, external: bool) -> None:
    assert is_external_url(url) is external


def test_external_llm_needs_explicit_consent_and_https() -> None:
    env = {
        "FUDISLTE_AI_SHARED_SECRET": SECRET,
        "FUDISLTE_AI_LLM_KIND": "openai",
        "FUDISLTE_AI_LLM_URL": "http://llm.example.com/v1",
        "FUDISLTE_AI_LLM_MODEL": "some-model",
    }
    with pytest.raises(ConfigError, match="FUDISLTE_AI_ALLOW_EXTERNAL_LLM"):
        load_settings(env)
    with pytest.raises(ConfigError, match="https"):
        load_settings({**env, "FUDISLTE_AI_ALLOW_EXTERNAL_LLM": "true"})
    s = load_settings({**env, "FUDISLTE_AI_ALLOW_EXTERNAL_LLM": "true", "FUDISLTE_AI_LLM_URL": "https://llm.example.com/v1"})
    assert s.llm_external


def test_separate_embedding_server_follows_the_same_rules() -> None:
    env = {
        "FUDISLTE_AI_SHARED_SECRET": SECRET,
        "FUDISLTE_AI_LLM_KIND": "openai",
        "FUDISLTE_AI_LLM_URL": "http://vllm-chat:8000/v1",
        "FUDISLTE_AI_LLM_MODEL": "chat-model",
        "FUDISLTE_AI_EMBED_MODEL": "embed-model",
        "FUDISLTE_AI_DATABASE_URL": "postgres://u:p@db:5432/x",
    }
    s = load_settings({**env, "FUDISLTE_AI_EMBED_URL": "http://vllm-embed:8001/v1/"})
    assert s.embed_url == "http://vllm-embed:8001/v1" and not s.llm_external
    with pytest.raises(ConfigError, match="FUDISLTE_AI_EMBED_URL points outside"):
        load_settings({**env, "FUDISLTE_AI_EMBED_URL": "https://embeddings.example.com/v1"})
    s = load_settings({**env, "FUDISLTE_AI_EMBED_URL": "https://embeddings.example.com/v1", "FUDISLTE_AI_ALLOW_EXTERNAL_LLM": "true"})
    assert s.llm_external


def test_invalid_numbers_are_reported() -> None:
    with pytest.raises(ConfigError) as err:
        load_settings({"FUDISLTE_AI_SHARED_SECRET": SECRET, "FUDISLTE_AI_EMBED_DIM": "4096", "FUDISLTE_AI_HTTP_ADDR": "nope"})
    assert "FUDISLTE_AI_EMBED_DIM" in str(err.value) and "FUDISLTE_AI_HTTP_ADDR" in str(err.value)
