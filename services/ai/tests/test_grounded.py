"""Summaries and task suggestions never contain entries without valid citations."""

from __future__ import annotations

import asyncio

from conftest import FakeChat, error_code, running

from fudislte_ai.grounded import clean_citations, summarize
from fudislte_ai.llm import LLMError
from fudislte_ai.schemas import SummarizeRequest

ITEMS = [
    {"id": "m1", "at": "2026-10-30T09:00:00Z", "author": "Dana", "text": "Let's ship the beta on Friday. Agreed?"},
    {"id": "m2", "at": "2026-10-30T09:01:00Z", "author": "Alex", "text": "Agreed, Friday it is. I will update the release notes."},
    {"id": "m3", "at": "2026-10-30T09:02:00Z", "author": "Dana", "text": "Mert, can you check the migration on staging?"},
]


def model_reply_with_inventions(_messages):
    return {
        "summary": "The team agreed to ship the beta on Friday.",
        "decisions": [
            {"text": "Ship the beta on Friday.", "citations": ["m1", "m2"]},
            # Invented: no such item.
            {"text": "Double the marketing budget.", "citations": ["m99"]},
            # No citations at all.
            {"text": "Hire two engineers.", "citations": []},
            "Move the office.",
        ],
        "actionItems": [
            {"text": "Update the release notes.", "citations": ["m2"], "assigneeHint": "Alex"},
            # One real and one invented citation: the invented one is removed.
            {"text": "Check the migration on staging.", "citations": ["m3", "x7"], "assigneeHint": "Mert"},
            # Invented item and invented person.
            {"text": "Call the bank.", "citations": ["m42"], "assigneeHint": "Zeynep"},
            # Real citation, but the hint is not in the cited item: the hint is dropped.
            {"text": "Confirm the date.", "citations": ["m1"], "assigneeHint": "Zeynep"},
        ],
    }


def test_invented_entries_are_dropped() -> None:
    chat = FakeChat([model_reply_with_inventions])
    with running(chat=chat) as w:
        r = w.post("/v1/summarize", {"kind": "meeting", "locale": "en", "items": ITEMS})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"] == "The team agreed to ship the beta on Friday."
    assert body["decisions"] == [{"text": "Ship the beta on Friday.", "citations": ["m1", "m2"]}]
    assert body["actionItems"] == [
        {"text": "Update the release notes.", "citations": ["m2"], "assigneeHint": "Alex"},
        {"text": "Check the migration on staging.", "citations": ["m3"], "assigneeHint": "Mert"},
        {"text": "Confirm the date.", "citations": ["m1"], "assigneeHint": None},
    ]
    assert body["dropped"] == {"decisions": 3, "actionItems": 1}
    assert body["model"] == "fake-model"
    for entry in body["decisions"] + body["actionItems"]:
        assert entry["citations"] and set(entry["citations"]) <= {"m1", "m2", "m3"}


def test_prompt_tells_the_model_to_state_only_what_items_say() -> None:
    chat = FakeChat([{"summary": "Özet.", "decisions": [], "actionItems": []}])
    with running(chat=chat) as w:
        r = w.post("/v1/summarize", {"kind": "channel", "locale": "tr", "items": ITEMS})
    assert r.status_code == 200
    system, user = chat.calls[0]
    assert system["role"] == "system"
    assert "State only what the items say" in system["content"]
    assert "never make up an id" in system["content"]
    assert "Turkish" in system["content"]
    assert "chat channel conversation" in system["content"]
    assert '"id": "m3"' in user["content"] and "check the migration" in user["content"]


def test_summarize_validation_and_failures() -> None:
    with running(chat=FakeChat([LLMError("model server unreachable (ConnectError)")])) as w:
        dup = w.post("/v1/summarize", {"kind": "meeting", "locale": "en", "items": [ITEMS[0], ITEMS[0]]})
        assert dup.status_code == 422 and error_code(dup) == "validation_failed"
        bad = w.post("/v1/summarize", {"kind": "novel", "locale": "de", "items": ITEMS})
        assert bad.status_code == 422 and {"kind", "locale"} <= set(bad.json()["error"]["fields"])
        extra = w.post("/v1/summarize", {"kind": "meeting", "locale": "en", "items": ITEMS, "x": 1})
        assert extra.status_code == 422
        down = w.post("/v1/summarize", {"kind": "meeting", "locale": "en", "items": ITEMS})
        assert down.status_code == 502 and error_code(down) == "llm_unavailable"


def test_long_inputs_are_summarized_in_batches_with_per_batch_citations() -> None:
    items = [{"id": f"i{n}", "author": "A", "text": f"point {n} " + "x" * 300} for n in range(6)]

    def reply(messages):
        if "combine partial summaries" in messages[0]["content"]:
            return {"summary": "combined"}
        user = messages[1]["content"]
        ids = [f"i{n}" for n in range(6) if f'"id": "i{n}"' in user]
        # Each batch cites its first item and also an item of another batch.
        other = "i5" if "i0" in ids else "i0"
        return {
            "summary": f"covers {','.join(ids)}",
            "decisions": [{"text": f"decision {ids[0]}", "citations": [ids[0]]}, {"text": "cross", "citations": [other]}],
            "actionItems": [],
        }

    chat = FakeChat([reply] * 20)
    req = SummarizeRequest.model_validate({"kind": "meeting", "locale": "en", "items": items})
    result = asyncio.run(summarize(chat, req, max_prompt_chars=800))
    batch_calls = [c for c in chat.calls if "Items, one JSON object per line" in c[1]["content"]]
    assert len(batch_calls) >= 2
    assert result.summary == "combined"
    assert all(d.text.startswith("decision") for d in result.decisions)
    assert result.dropped.decisions == len(batch_calls)  # every "cross" citation pointed outside its batch


def test_clean_citations() -> None:
    known = {"a", "b", "12"}
    assert clean_citations(["a", "zz", "a", 12, True, None, {"id": "b"}], known) == ["a", "12"]
    assert clean_citations("b", known) == ["b"]
    assert clean_citations(None, known) == []


def test_suggest_tasks_keeps_only_cited_suggestions() -> None:
    reply = {
        "suggestions": [
            {"title": "Update the release notes", "description": "Alex will update them.", "citations": ["m2"]},
            {"title": "Buy new laptops", "description": "Invented.", "citations": ["m77"]},
            {"title": "", "description": "No title.", "citations": ["m1"]},
            {"title": "Check staging migration", "citations": ["m3", "m3"]},
        ]
    }
    chat = FakeChat([reply])
    with running(chat=chat) as w:
        r = w.post("/v1/suggest-tasks", {"orgId": "org-1", "locale": "en", "items": ITEMS})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["suggestions"] == [
        {"title": "Update the release notes", "description": "Alex will update them.", "citations": ["m2"]},
        {"title": "Check staging migration", "description": "", "citations": ["m3"]},
    ]
    assert body["dropped"] == 2
    system = chat.calls[0][0]["content"]
    assert "nothing is created automatically" in system and "never make up an id" in system


def test_llm_endpoints_report_capability_disabled() -> None:
    with running() as w:
        r = w.post("/v1/suggest-tasks", {"orgId": "o", "locale": "en", "items": ITEMS})
        assert r.status_code == 503 and error_code(r) == "capability_disabled"
