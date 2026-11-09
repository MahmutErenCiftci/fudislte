"""The bounded agent loop, approvals and the in-memory run store.

A run alternates model steps and tool calls until the model gives a final answer, a
destructive tool needs approval (the run pauses), or a limit is reached. Limits: model
steps, tool calls and active wall time (time spent waiting for a person does not count).
Every step is appended to the run's audit list. Runs live in memory with a TTL; the
FUDISLTE API keeps the authoritative record (it stores the run it gets back).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from .. import prompts
from ..errors import ApiError
from ..llm import ChatModel, LLMError, Message
from .client import ApprovalProof, FudislteClient, ToolCallError
from .schemas import ApproveRequest, Limits, RejectRequest, StartRunRequest
from .tools import Tool, ToolArgumentError, ToolRegistry, action_hash

log = logging.getLogger("fudislte_ai.agents")

TERMINAL = ("completed", "failed", "limit_exceeded")
MAX_RESULT_CHARS = 12_000
MAX_PREVIEW_CHARS = 1_000
MAX_ANSWER_CHARS = 8_000
MAX_SOURCES = 20
MAX_INVALID_IN_A_ROW = 2
MIN_APPROVED_TOOL_SECONDS = 10.0


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


@dataclass
class PendingAction:
    action_id: str
    tool: str
    arguments: dict[str, Any]
    hash: str
    reason: str
    requested_at: datetime

    def public(self) -> dict[str, Any]:
        return {
            "actionId": self.action_id,
            "tool": self.tool,
            "arguments": self.arguments,
            "hash": self.hash,
            "reason": self.reason,
            "requestedAt": _iso(self.requested_at),
        }


@dataclass(eq=False)
class Run:
    id: str
    org_id: str
    user_id: str
    agent: str
    goal: str
    locale: str
    limits: Limits
    created_at: datetime
    expires_at: datetime
    token: str | None = field(default=None, repr=False)
    status: str = "running"
    messages: list[Message] = field(default_factory=list, repr=False)
    audit: list[dict[str, Any]] = field(default_factory=list)
    steps: int = 0
    tool_calls: int = 0
    active_seconds: float = 0.0
    pending: PendingAction | None = None
    used_actions: set[str] = field(default_factory=set)
    answer: str | None = None
    sources: list[dict[str, str]] = field(default_factory=list)
    seen_sources: set[tuple[str, str]] = field(default_factory=set, repr=False)
    error: dict[str, str] | None = None
    invalid_in_a_row: int = 0
    updated_at: datetime | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def record(self, kind: str, **details: Any) -> None:
        self.audit.append({"seq": len(self.audit) + 1, "at": _iso(_now()), "type": kind, **details})

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "orgId": self.org_id,
            "userId": self.user_id,
            "agent": self.agent,
            "goal": self.goal,
            "locale": self.locale,
            "status": self.status,
            "answer": self.answer,
            "sources": list(self.sources),
            "pendingApproval": self.pending.public() if self.pending else None,
            "error": self.error,
            "usage": {
                "steps": self.steps,
                "toolCalls": self.tool_calls,
                "activeSeconds": round(self.active_seconds, 3),
            },
            "limits": self.limits.model_dump(by_alias=True),
            "audit": list(self.audit),
            "createdAt": _iso(self.created_at),
            "updatedAt": _iso(self.updated_at or self.created_at),
            "expiresAt": _iso(self.expires_at),
        }


class RunStore:
    """Runs in memory, removed `ttl` after their last change. Bounded in number."""

    def __init__(self, ttl_seconds: int, max_runs: int, now: Callable[[], datetime] = _now) -> None:
        self.ttl = timedelta(seconds=ttl_seconds)
        self.max_runs = max_runs
        self.now = now
        self.runs: dict[str, Run] = {}

    def new_expiry(self) -> datetime:
        return self.now() + self.ttl

    def add(self, run: Run) -> None:
        self.sweep()
        if len(self.runs) >= self.max_runs:
            finished = sorted(
                (r for r in self.runs.values() if r.status in TERMINAL and not r.lock.locked()),
                key=lambda r: r.updated_at or r.created_at,
            )
            for old in finished[: len(self.runs) - self.max_runs + 1]:
                del self.runs[old.id]
        if len(self.runs) >= self.max_runs:
            raise ApiError(429, "too_many_runs", "Too many agent runs are active or waiting for approval.")
        self.runs[run.id] = run

    def get(self, run_id: str) -> Run:
        run = self.runs.get(run_id)
        if run is not None and run.expires_at <= self.now() and not run.lock.locked():
            del self.runs[run_id]
            run = None
        if run is None:
            raise ApiError(404, "run_not_found", "No such agent run (it may have expired).")
        return run

    def touch(self, run: Run) -> None:
        run.updated_at = self.now()
        run.expires_at = run.updated_at + self.ttl

    def sweep(self) -> int:
        now = self.now()
        expired = [r.id for r in self.runs.values() if r.expires_at <= now and not r.lock.locked()]
        for run_id in expired:
            del self.runs[run_id]
        return len(expired)


def _tool_message(tool: str, ok: bool, payload: Any) -> Message:
    text = _dump(payload)
    if len(text) > MAX_RESULT_CHARS:
        payload = {"truncated": True, "text": text[:MAX_RESULT_CHARS]}
    body = {"toolResult": {"tool": tool, "ok": ok, ("result" if ok else "error"): payload}}
    return {"role": "user", "content": _dump(body)}


def _collect_sources(run: Run, value: Any, depth: int = 0) -> None:
    if depth > 6 or len(run.seen_sources) >= 1000:
        return
    if isinstance(value, dict):
        st, sid = value.get("sourceType"), value.get("sourceId")
        if isinstance(st, str) and isinstance(sid, str):
            run.seen_sources.add((st, sid))
        for child in value.values():
            _collect_sources(run, child, depth + 1)
    elif isinstance(value, list):
        for child in value[:500]:
            _collect_sources(run, child, depth + 1)


class AgentRunner:
    def __init__(
        self,
        chat: ChatModel,
        registry: ToolRegistry,
        store: RunStore,
        client_factory: Callable[[Run], FudislteClient],
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.chat = chat
        self.registry = registry
        self.store = store
        self.client_factory = client_factory
        self.monotonic = monotonic

    # --- entry points -------------------------------------------------------------

    async def start(self, req: StartRunRequest) -> Run:
        run = Run(
            id=str(uuid.uuid4()),
            org_id=req.org_id,
            user_id=req.user_id,
            agent=req.agent,
            goal=req.goal,
            locale=req.locale,
            limits=req.limits,
            created_at=_now(),
            expires_at=self.store.new_expiry(),
            token=req.delegated_token.get_secret_value(),
        )
        system = prompts.agent_system(req.agent, req.locale, self.registry.prompt_text(req.agent))
        run.messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": _dump({"goal": req.goal, "context": req.context})},
        ]
        run.record("run_started", agent=req.agent, userId=req.user_id, goal=req.goal, limits=req.limits.model_dump(by_alias=True))
        self.store.add(run)
        async with run.lock:
            await self._advance(run)
        return run

    async def approve(self, run_id: str, req: ApproveRequest) -> Run:
        run = self.store.get(run_id)
        async with run.lock:
            pending = self._claim(run, req.action_id, req.hash, req.approved_by)
            run.record("approval_granted", actionId=pending.action_id, tool=pending.tool, hash=pending.hash, approvedBy=req.approved_by)
            if req.delegated_token is not None:
                run.token = req.delegated_token.get_secret_value()
            run.status = "running"
            proof = ApprovalProof(pending.action_id, pending.hash, req.approved_by)
            tool = self.registry.tools[pending.tool]

            async def execute(remaining: Callable[[], float]) -> None:
                # Exactly the stored call: the request only names and confirms it.
                timeout = max(remaining(), MIN_APPROVED_TOOL_SECONDS)
                await self._execute(run, tool, pending.arguments, proof, timeout)

            await self._advance(run, before=execute)
        return run

    async def reject(self, run_id: str, req: RejectRequest) -> Run:
        run = self.store.get(run_id)
        async with run.lock:
            pending = self._claim(run, req.action_id, req.hash, req.rejected_by)
            run.record("action_rejected", actionId=pending.action_id, tool=pending.tool, rejectedBy=req.rejected_by, reason=req.reason)
            run.messages.append(
                _tool_message(
                    pending.tool,
                    False,
                    {
                        "code": "rejected_by_user",
                        "message": "A person rejected this action. Do not repeat it; continue without it or give your final answer.",
                    },
                )
            )
            run.status = "running"
            await self._advance(run)
        return run

    # --- internals ----------------------------------------------------------------

    def _claim(self, run: Run, action_id: str, given_hash: str, actor: str) -> PendingAction:
        """Validates an approval or rejection and consumes the pending action."""
        if action_id in run.used_actions:
            run.record("approval_refused", actionId=action_id, reason="already_used", by=actor)
            raise ApiError(409, "approval_used", "This action was already approved or rejected.")
        pending = run.pending
        if run.status != "awaiting_approval" or pending is None or pending.action_id != action_id:
            run.record("approval_refused", actionId=action_id, reason="not_pending", by=actor)
            raise ApiError(409, "approval_not_pending", "The run is not waiting for this action.")
        if not hmac.compare_digest(pending.hash.encode(), given_hash.encode()):
            run.record("approval_refused", actionId=action_id, reason="hash_mismatch", by=actor)
            raise ApiError(403, "approval_mismatch", "The approval does not match the pending action.")
        run.used_actions.add(action_id)
        run.pending = None
        return pending

    async def _advance(self, run: Run, before: Callable[[Callable[[], float]], Awaitable[None]] | None = None) -> None:
        started = self.monotonic()

        def remaining() -> float:
            return run.limits.max_wall_seconds - run.active_seconds - (self.monotonic() - started)

        try:
            if before is not None:
                await before(remaining)
            while run.status == "running":
                if remaining() <= 0:
                    self._limit(run, "max_wall_time")
                    break
                if run.steps >= run.limits.max_steps:
                    self._limit(run, "max_steps")
                    break
                run.steps += 1
                try:
                    reply = await asyncio.wait_for(self.chat.chat_json(run.messages), timeout=remaining())
                except TimeoutError:
                    self._limit(run, "max_wall_time")
                    break
                except LLMError as exc:
                    self._fail(run, exc.code, str(exc))
                    break
                await self._handle(run, reply, remaining)
        except Exception:
            log.exception("agent run %s failed", run.id)
            self._fail(run, "internal_error", "The agent run failed unexpectedly.")
        finally:
            run.active_seconds += self.monotonic() - started
            self.store.touch(run)
            if run.status in TERMINAL:
                # The delegated token and the conversation are not needed any more.
                run.token = None
                run.messages = []

    async def _handle(self, run: Run, reply: dict[str, Any], remaining: Callable[[], float]) -> None:
        run.messages.append({"role": "assistant", "content": _dump(reply)[:MAX_RESULT_CHARS]})
        kind = reply.get("type")

        if kind == "final" and isinstance(reply.get("answer"), str) and reply["answer"].strip():
            run.invalid_in_a_row = 0
            run.record("model_step", step=run.steps, decision="final")
            sources: list[dict[str, str]] = []
            for src in reply.get("sources") or []:
                if not isinstance(src, dict):
                    continue
                pair = (src.get("sourceType"), src.get("sourceId"))
                entry = {"sourceType": pair[0], "sourceId": pair[1]}
                # Only sources that tool results actually contained.
                if pair in run.seen_sources and entry not in sources:
                    sources.append(entry)
            run.answer = reply["answer"].strip()[:MAX_ANSWER_CHARS]
            run.sources = sources[:MAX_SOURCES]
            run.status = "completed"
            run.record("run_completed", sources=len(run.sources))
            return

        if kind == "tool":
            run.invalid_in_a_row = 0
            name = reply.get("tool")
            reason = " ".join(str(reply.get("reason") or "").split())[:500]
            shown = name[:100] if isinstance(name, str) else repr(name)[:100]
            run.record("model_step", step=run.steps, decision="tool", tool=shown, reason=reason)
            tool = self.registry.get(run.agent, name)
            if tool is None:
                message = f"No tool named {shown!r} is available to this agent."
                run.record("tool_refused", tool=shown, code="unknown_tool", message=message)
                run.messages.append(_tool_message(shown, False, {"code": "unknown_tool", "message": message}))
                return
            try:
                arguments = tool.validate(reply.get("arguments", {}))
            except ToolArgumentError as exc:
                run.record("tool_refused", tool=tool.name, code="invalid_arguments", message=str(exc))
                run.messages.append(_tool_message(tool.name, False, {"code": "invalid_arguments", "message": str(exc)}))
                return
            if run.tool_calls >= run.limits.max_tool_calls:
                self._limit(run, "max_tool_calls")
                return
            if tool.destructive:
                pending = PendingAction(
                    action_id=str(uuid.uuid4()),
                    tool=tool.name,
                    arguments=arguments,
                    hash=action_hash(tool.name, arguments),
                    reason=reason,
                    requested_at=_now(),
                )
                run.pending = pending
                run.status = "awaiting_approval"
                run.record("approval_requested", actionId=pending.action_id, tool=tool.name, arguments=arguments, hash=pending.hash, reason=reason)
                return
            if remaining() <= 0:
                self._limit(run, "max_wall_time")
                return
            await self._execute(run, tool, arguments, None, remaining())
            return

        run.invalid_in_a_row += 1
        run.record("model_step", step=run.steps, decision="invalid")
        if run.invalid_in_a_row >= MAX_INVALID_IN_A_ROW:
            self._fail(run, "llm_invalid_output", "The model did not follow the answer format.")
            return
        run.messages.append(
            {
                "role": "user",
                "content": 'Answer with exactly one JSON object: {"type": "tool", ...} or {"type": "final", ...}.',
            }
        )

    async def _execute(self, run: Run, tool: Tool, arguments: dict[str, Any], approval: ApprovalProof | None, timeout: float) -> None:
        run.tool_calls += 1
        details: dict[str, Any] = {"tool": tool.name, "arguments": arguments, "destructive": tool.destructive}
        if approval is not None:
            details.update(actionId=approval.action_id, approvedBy=approval.approved_by)
        run.record("tool_called", **details)
        client = self.client_factory(run)
        try:
            result = await asyncio.wait_for(client.call_tool(tool.name, arguments, approval=approval), timeout=timeout)
        except ToolCallError as exc:
            error = {"code": exc.code, "message": exc.message}
            run.record("tool_result", tool=tool.name, ok=False, error=error)
            run.messages.append(_tool_message(tool.name, False, error))
            return
        except TimeoutError:
            error = {"code": "tool_timeout", "message": "The tool did not answer in time."}
            run.record("tool_result", tool=tool.name, ok=False, error=error)
            run.messages.append(_tool_message(tool.name, False, error))
            return
        _collect_sources(run, result)
        run.record("tool_result", tool=tool.name, ok=True, preview=_dump(result)[:MAX_PREVIEW_CHARS])
        run.messages.append(_tool_message(tool.name, True, result))

    def _limit(self, run: Run, which: str) -> None:
        run.status = "limit_exceeded"
        run.error = {"code": which, "message": f"The run stopped at its {which.replace('_', ' ')} limit."}
        run.record("limit_reached", limit=which)

    def _fail(self, run: Run, code: str, message: str) -> None:
        run.status = "failed"
        run.error = {"code": code, "message": message}
        run.record("run_failed", code=code, message=message)
