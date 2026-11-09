"""Request shapes for /v1/agents/*."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import Field, SecretStr, field_validator

from ..schemas import Id, Locale, Model

AgentKind = Literal["research", "developer", "project", "data", "whiteboard", "voice"]

MAX_CONTEXT_BYTES = 32 << 10


class Limits(Model):
    """Per-run bounds; the ceilings (le=...) are fixed in the worker."""

    max_steps: int = Field(default=8, ge=1, le=32)
    max_tool_calls: int = Field(default=12, ge=0, le=64)
    max_wall_seconds: int = Field(default=120, ge=5, le=900)


def _token(value: SecretStr | None) -> SecretStr | None:
    if value is not None and not 16 <= len(value.get_secret_value()) <= 4096:
        raise ValueError("delegatedToken must be 16 to 4096 characters")
    return value


class StartRunRequest(Model):
    org_id: Id
    user_id: Id
    agent: AgentKind
    goal: str = Field(min_length=1, max_length=4000)
    context: dict[str, Any] = Field(default_factory=dict)
    limits: Limits = Field(default_factory=Limits)
    locale: Locale = "tr"
    delegated_token: SecretStr

    @field_validator("context")
    @classmethod
    def _small_context(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_CONTEXT_BYTES:
            raise ValueError("context must be at most 32 KiB of JSON")
        return value

    @field_validator("delegated_token")
    @classmethod
    def _check_token(cls, value: SecretStr) -> SecretStr:
        return _token(value)


class ApproveRequest(Model):
    action_id: Id
    hash: str = Field(min_length=1, max_length=128)
    approved_by: Id
    # Optional fresh token when the run's original one may have expired while waiting.
    delegated_token: SecretStr | None = None

    @field_validator("delegated_token")
    @classmethod
    def _check_token(cls, value: SecretStr | None) -> SecretStr | None:
        return _token(value)


class RejectRequest(Model):
    action_id: Id
    hash: str = Field(min_length=1, max_length=128)
    rejected_by: Id
    reason: str = Field(default="", max_length=500)
