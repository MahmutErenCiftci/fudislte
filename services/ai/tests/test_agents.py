"""Agent runs: bounded loop, approvals for destructive tools, audit, limits."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from conftest import SECRET, FakeChat, error_code, running

from fudislte_ai.agents.catalog import AGENT_TOOLS, TOOLS, default_registry
from fudislte_ai.agents.client import ApprovalProof, HttpFudislteClient, ToolCallError
from fudislte_ai.agents.runner import AgentRunner, RunStore
from fudislte_ai.agents.schemas import StartRunRequest
from fudislte_ai.agents.tools import action_hash, canonical_json
from fudislte_ai.auth import compute_signature
from fudislte_ai.errors import ApiError

TOKEN = "delegated-token-for-this-run-0001"


class FakeFudislte:
    """Stands in for the FUDISLTE API's tool callbacks; records every call."""

    def __init__(self, results: dict[str, Any] | None = None) -> None:
        self.results = results or {}
        self.calls: list[tuple[str, dict[str, Any], ApprovalProof | None]] = []

    async def call_tool(self, tool: str, arguments: dict[str, Any], *, approval: ApprovalProof | None = None) -> Any:
        self.calls.append((tool, arguments, approval))
        result = self.results.get(tool, {"ok": True})
        if isinstance(result, Exception):
            raise result
        return result


def run_body(agent: str = "research", **extra: Any) -> dict[str, Any]:
    return {
        "orgId": "org-1",
        "userId": "user-1",
        "agent": agent,
        "goal": "What did we decide about the beta?",
        "context": {"channelId": "c1"},
        "locale": "en",
        "delegatedToken": TOKEN,
        **extra,
    }


def tool(name: str, arguments: dict[str, Any], reason: str = "needed") -> dict[str, Any]:
    return {"type": "tool", "tool": name, "arguments": arguments, "reason": reason}


def final(answer: str, sources: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {"type": "final", "answer": answer, "sources": sources or []}


def audit_types(run: dict[str, Any]) -> list[str]:
    return [entry["type"] for entry in run["audit"]]


def test_read_only_run_completes_with_verified_sources() -> None:
    fudislte = FakeFudislte(
        {"search": {"items": [{"sourceType": "message", "sourceId": "m1", "text": "Beta ships Friday."}]}}
    )
    chat = FakeChat(
        [
            tool("search", {"query": "beta decision"}),
            final(
                "The beta ships on Friday.",
                [{"sourceType": "message", "sourceId": "m1"}, {"sourceType": "message", "sourceId": "m404"}],
            ),
        ]
    )
    with running(chat=chat, client_factory=lambda run: fudislte) as w:
        r = w.post("/v1/agents/runs", run_body())
        assert r.status_code == 201, r.text
        run = r.json()
        assert run["status"] == "completed"
        assert run["answer"] == "The beta ships on Friday."
        # The invented source is not passed on.
        assert run["sources"] == [{"sourceType": "message", "sourceId": "m1"}]
        assert fudislte.calls == [("search", {"query": "beta decision", "limit": 8}, None)]
        assert audit_types(run) == [
            "run_started", "model_step", "tool_called", "tool_result", "model_step", "run_completed",
        ]
        assert run["usage"]["steps"] == 2 and run["usage"]["toolCalls"] == 1
        assert TOKEN not in r.text

        again = w.get(f"/v1/agents/runs/{run['id']}")
        assert again.status_code == 200 and again.json()["status"] == "completed"
        assert TOKEN not in again.text

    system = chat.calls[0][0]["content"]
    assert "no shell, no file system and no internet access" in system
    assert "search (read-only)" in system and "create_task" not in system


def start_paused(w, fudislte: FakeFudislte, extra_replies: list[Any]) -> tuple[dict[str, Any], FakeChat]:
    args = {"projectId": "p1", "title": "Update release notes", "description": "From the meeting."}
    chat = FakeChat([tool("create_task", args, "The meeting asked for it.")] + extra_replies)
    w.app.state.services.runner.chat = chat
    r = w.post("/v1/agents/runs", run_body("project"))
    assert r.status_code == 201, r.text
    return r.json(), chat


def test_destructive_tool_pauses_and_runs_once_after_approval() -> None:
    fudislte = FakeFudislte({"create_task": {"taskId": "t9", "sourceType": "task", "sourceId": "t9"}})
    with running(chat=FakeChat([]), client_factory=lambda run: fudislte) as w:
        run, _ = start_paused(w, fudislte, [final("Created the task.", [{"sourceType": "task", "sourceId": "t9"}])])
        assert run["status"] == "awaiting_approval"
        pending = run["pendingApproval"]
        expected_args = {"projectId": "p1", "title": "Update release notes", "description": "From the meeting."}
        assert pending["tool"] == "create_task" and pending["arguments"] == expected_args
        assert pending["hash"] == action_hash("create_task", expected_args)
        assert fudislte.calls == []  # nothing executed inside the loop

        approve = {"actionId": pending["actionId"], "hash": pending["hash"], "approvedBy": "user-1"}
        r = w.post(f"/v1/agents/runs/{run['id']}/approve", approve)
        assert r.status_code == 200, r.text
        done = r.json()
        assert done["status"] == "completed" and done["pendingApproval"] is None
        assert done["sources"] == [{"sourceType": "task", "sourceId": "t9"}]
        assert len(fudislte.calls) == 1
        name, args, proof = fudislte.calls[0]
        assert (name, args) == ("create_task", expected_args)
        assert proof == ApprovalProof(pending["actionId"], pending["hash"], "user-1")
        types = audit_types(done)
        assert types[types.index("approval_requested") + 1] == "approval_granted"
        called = [e for e in done["audit"] if e["type"] == "tool_called"][0]
        assert called["destructive"] is True and called["approvedBy"] == "user-1"

        # The same approval cannot be used twice.
        r = w.post(f"/v1/agents/runs/{run['id']}/approve", approve)
        assert r.status_code == 409 and error_code(r) == "approval_used"
        assert len(fudislte.calls) == 1


def test_tampered_approval_is_refused() -> None:
    fudislte = FakeFudislte()
    with running(chat=FakeChat([]), client_factory=lambda run: fudislte) as w:
        run, _ = start_paused(w, fudislte, [final("Done.")])
        pending = run["pendingApproval"]
        url = f"/v1/agents/runs/{run['id']}/approve"

        other_hash = action_hash("create_task", {**pending["arguments"], "title": "Delete everything"})
        r = w.post(url, {"actionId": pending["actionId"], "hash": other_hash, "approvedBy": "user-1"})
        assert r.status_code == 403 and error_code(r) == "approval_mismatch"
        r = w.post(url, {"actionId": "not-the-action", "hash": pending["hash"], "approvedBy": "user-1"})
        assert r.status_code == 409 and error_code(r) == "approval_not_pending"
        # Arguments cannot be smuggled in with the approval.
        r = w.post(url, {"actionId": pending["actionId"], "hash": pending["hash"], "approvedBy": "u", "arguments": {}})
        assert r.status_code == 422
        assert fudislte.calls == []

        current = w.get(f"/v1/agents/runs/{run['id']}").json()
        assert current["status"] == "awaiting_approval"
        refusals = [e["reason"] for e in current["audit"] if e["type"] == "approval_refused"]
        assert refusals == ["hash_mismatch", "not_pending"]

        # The genuine approval still works afterwards.
        r = w.post(url, {"actionId": pending["actionId"], "hash": pending["hash"], "approvedBy": "user-1"})
        assert r.status_code == 200 and r.json()["status"] == "completed"
        assert len(fudislte.calls) == 1


def test_rejected_action_is_skipped() -> None:
    fudislte = FakeFudislte()
    with running(chat=FakeChat([]), client_factory=lambda run: fudislte) as w:
        run, chat = start_paused(w, fudislte, [final("I did not create the task.")])
        pending = run["pendingApproval"]
        r = w.post(
            f"/v1/agents/runs/{run['id']}/reject",
            {"actionId": pending["actionId"], "hash": pending["hash"], "rejectedBy": "user-1", "reason": "not now"},
        )
        assert r.status_code == 200, r.text
        done = r.json()
        assert done["status"] == "completed" and fudislte.calls == []
        assert "action_rejected" in audit_types(done) and "tool_called" not in audit_types(done)
        last_prompt = chat.calls[-1][-1]["content"]
        assert "rejected_by_user" in last_prompt
        # A rejected action cannot be approved afterwards.
        r = w.post(
            f"/v1/agents/runs/{run['id']}/approve",
            {"actionId": pending["actionId"], "hash": pending["hash"], "approvedBy": "user-1"},
        )
        assert r.status_code == 409 and error_code(r) == "approval_used"
        assert fudislte.calls == []


def test_unknown_foreign_and_malformed_tool_calls_are_refused() -> None:
    fudislte = FakeFudislte()
    chat = FakeChat(
        [
            tool("shell", {"command": "rm -rf /"}),
            tool("create_task", {"projectId": "p", "title": "x"}),  # not a research tool
            tool("search", {"query": "x", "url": "http://evil.example"}),  # unknown argument
            {"type": "dance"},
            final("I could not do that."),
        ]
    )
    with running(chat=chat, client_factory=lambda run: fudislte) as w:
        run = w.post("/v1/agents/runs", run_body("research")).json()
    assert run["status"] == "completed"
    assert fudislte.calls == []
    refused = [(e["tool"], e["code"]) for e in run["audit"] if e["type"] == "tool_refused"]
    assert refused == [("shell", "unknown_tool"), ("create_task", "unknown_tool"), ("search", "invalid_arguments")]
    assert "approval_requested" not in audit_types(run)


def test_tool_errors_are_reported_to_the_model() -> None:
    fudislte = FakeFudislte({"search": ToolCallError("tool_unavailable", "Not implemented yet.")})
    chat = FakeChat([tool("search", {"query": "x"}), final("Search is not available.")])
    with running(chat=chat, client_factory=lambda run: fudislte) as w:
        run = w.post("/v1/agents/runs", run_body()).json()
    assert run["status"] == "completed"
    result = [e for e in run["audit"] if e["type"] == "tool_result"][0]
    assert result["ok"] is False and result["error"]["code"] == "tool_unavailable"
    assert "tool_unavailable" in chat.calls[1][-1]["content"]


def test_step_and_tool_call_limits() -> None:
    fudislte = FakeFudislte()
    chat = FakeChat([tool("search", {"query": f"q{i}"}) for i in range(10)])
    with running(chat=chat, client_factory=lambda run: fudislte) as w:
        run = w.post("/v1/agents/runs", run_body(limits={"maxSteps": 3})).json()
        assert run["status"] == "limit_exceeded" and run["error"]["code"] == "max_steps"
        assert run["usage"]["steps"] == 3 and audit_types(run)[-1] == "limit_reached"

        w.app.state.services.runner.chat = FakeChat([tool("search", {"query": f"q{i}"}) for i in range(10)])
        run = w.post("/v1/agents/runs", run_body(limits={"maxToolCalls": 1})).json()
        assert run["status"] == "limit_exceeded" and run["error"]["code"] == "max_tool_calls"
        assert run["usage"]["toolCalls"] == 1

        r = w.post("/v1/agents/runs", run_body(limits={"maxSteps": 1000}))
        assert r.status_code == 422


def test_wall_time_limit_with_a_fake_clock() -> None:
    clock = {"now": 0.0}

    async def slow_reply(_messages):
        clock["now"] += 50.0
        return tool("search", {"query": "again"})

    async def scenario():
        runner = AgentRunner(
            FakeChat([slow_reply] * 10), default_registry(), RunStore(3600, 10), lambda run: FakeFudislte(),
            monotonic=lambda: clock["now"],
        )
        req = StartRunRequest.model_validate(run_body(limits={"maxWallSeconds": 120, "maxSteps": 20}))
        return await runner.start(req)

    run = asyncio.run(scenario())
    assert run.status == "limit_exceeded" and run.error["code"] == "max_wall_time"
    assert run.steps == 3 and run.active_seconds == 150.0
    assert run.token is None and run.messages == []  # dropped once the run ended


def test_model_that_ignores_the_format_fails_the_run() -> None:
    with running(chat=FakeChat([{"hello": 1}, {"type": "final", "answer": ""}]), client_factory=lambda r: FakeFudislte()) as w:
        run = w.post("/v1/agents/runs", run_body()).json()
    assert run["status"] == "failed" and run["error"]["code"] == "llm_invalid_output"


def test_agents_need_an_llm_and_a_token() -> None:
    with running() as w:
        r = w.post("/v1/agents/runs", run_body())
        assert r.status_code == 503 and error_code(r) == "capability_disabled"
        catalog = w.get("/v1/agents").json()
        assert [a["agent"] for a in catalog["agents"]] == list(AGENT_TOOLS)
    with running(chat=FakeChat([])) as w:
        r = w.post("/v1/agents/runs", run_body(delegatedToken="short"))
        assert r.status_code == 422


def test_runs_expire_and_are_bounded() -> None:
    now = {"t": datetime(2026, 10, 30, tzinfo=UTC)}
    store = RunStore(ttl_seconds=60, max_runs=2, now=lambda: now["t"])
    runner = AgentRunner(FakeChat([final("ok")] * 4), default_registry(), store, lambda r: FakeFudislte())
    req = StartRunRequest.model_validate(run_body())

    first = asyncio.run(runner.start(req))
    assert store.get(first.id) is first
    now["t"] += timedelta(seconds=61)
    with pytest.raises(ApiError) as err:
        store.get(first.id)
    assert err.value.code == "run_not_found"

    # Finished runs make room for new ones; the store never grows past max_runs.
    runs = [asyncio.run(runner.start(req)) for _ in range(3)]
    assert all(r.status == "completed" for r in runs)
    assert set(store.runs) == {runs[1].id, runs[2].id}


def test_registry_has_no_shell_file_or_network_tools() -> None:
    names = {t.name for t in TOOLS}
    for forbidden in ("shell", "exec", "bash", "python", "file", "read_file", "write_file", "http", "fetch", "browse", "url"):
        assert forbidden not in names
    for t in TOOLS:
        props = json.dumps(t.schema).lower()
        assert "url" not in props and "path" not in props and "command" not in props
    assert {t.name for t in TOOLS if t.destructive} == {"create_task", "update_task", "post_message", "add_whiteboard_elements"}


def test_canonical_arguments_and_hash_vector() -> None:
    args = {"text": "Merhaba dünya", "channelId": "c1"}
    assert canonical_json(args) == '{"channelId":"c1","text":"Merhaba d\\u00fcnya"}'
    # Published in docs/architecture/ai-worker.md.
    assert action_hash("post_message", args) == "fe1be5daa00e06445f67a142ea8675421abc3c91a6bf2794b9cc0d0ae169f236"


def test_http_client_signs_and_sends_only_to_the_api() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/redirect_me"):
            return httpx.Response(302, headers={"Location": "http://evil.example/"})
        if request.url.path.endswith("/broken"):
            return httpx.Response(404, json={"error": {"code": "tool_unavailable", "message": "nope"}})
        return httpx.Response(200, json={"items": []})

    def client_for(http: httpx.AsyncClient, base_url: str) -> HttpFudislteClient:
        return HttpFudislteClient(
            http, base_url=base_url, secret=SECRET, token=TOKEN,
            run_id="r1", org_id="o1", user_id="u1", agent="project",
        )

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = client_for(http, "http://api:8080")
            ok = await client.call_tool("search", {"query": "x"})
            proof = ApprovalProof("a1", "h" * 64, "u1")
            await client.call_tool("create_task", {"projectId": "p", "title": "t"}, approval=proof)
            errors = []
            for name in ("broken", "redirect_me"):
                try:
                    await client.call_tool(name, {})
                except ToolCallError as exc:
                    errors.append(exc.code)
            # A base URL with a path prefix: the prefix is part of the signed target.
            await client_for(http, "http://api:8080/fudislte/").call_tool("search", {"query": "y"})
            return ok, errors

    ok, errors = asyncio.run(scenario())
    assert ok == {"items": []}
    assert errors == ["tool_unavailable", "api_error"]
    assert all(str(r.url).startswith("http://api:8080/") for r in seen)
    first, second, prefixed = seen[0], seen[1], seen[-1]
    assert first.headers["Authorization"] == f"Bearer {TOKEN}"
    body = first.content
    assert json.loads(body) == {"runId": "r1", "orgId": "o1", "userId": "u1", "agent": "project", "tool": "search", "arguments": {"query": "x"}}
    for request in (first, second, prefixed):
        ts = request.headers["X-FUDISLTE-Timestamp"]
        # The signature covers the method and the request target exactly as sent.
        assert request.headers["X-FUDISLTE-Signature"] == compute_signature(
            SECRET, ts, request.method, request.url.raw_path, request.content
        )
    assert first.method == "POST" and first.url.raw_path == b"/internal/ai/tools/search"
    assert prefixed.url.raw_path == b"/fudislte/internal/ai/tools/search"
    assert first.headers["X-FUDISLTE-Signature"] == compute_signature(
        SECRET, first.headers["X-FUDISLTE-Timestamp"], "POST", "/internal/ai/tools/search", body
    )
    assert first.headers["X-FUDISLTE-Signature"] != compute_signature(
        SECRET, first.headers["X-FUDISLTE-Timestamp"], "POST", "/internal/ai/tools/create_task", body
    )
    assert "X-FUDISLTE-Approval-Action" not in first.headers
    assert second.headers["X-FUDISLTE-Approval-Action"] == "a1"
    assert second.headers["X-FUDISLTE-Approval-Hash"] == "h" * 64
