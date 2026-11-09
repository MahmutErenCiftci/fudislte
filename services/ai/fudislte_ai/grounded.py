"""Summaries and task suggestions in which every decision, action item and suggestion
cites input items. The model is asked to cite; this module enforces it: citations to ids
that are not in the input are removed, and entries left without a citation are dropped.
"""

from __future__ import annotations

import json
from typing import Any

from . import prompts
from .errors import ApiError
from .llm import ChatModel
from .schemas import (
    ActionItem,
    Decision,
    Dropped,
    Item,
    SuggestTasksRequest,
    SuggestTasksResponse,
    Suggestion,
    SummarizeRequest,
    SummarizeResponse,
)

MAX_PROMPT_CHARS = 24_000
MAX_BATCHES = 64
MAX_SUMMARY_CHARS = 8_000
MAX_ENTRY_CHARS = 1_000
MAX_ENTRIES = 50
MAX_SUGGESTIONS = 30


def render_items(items: list[Item]) -> str:
    lines = [
        json.dumps(
            {
                "id": item.id,
                "at": item.at.isoformat() if item.at else None,
                "author": item.author,
                "text": item.text,
            },
            ensure_ascii=False,
        )
        for item in items
    ]
    return "Items, one JSON object per line:\n" + "\n".join(lines)


def batches(items: list[Item], max_chars: int) -> list[list[Item]]:
    """Splits items, in order, into groups whose rendered size stays under max_chars."""
    out: list[list[Item]] = []
    current: list[Item] = []
    size = 0
    for item in items:
        cost = len(item.text) + len(item.author) + len(item.id) + 64
        if current and size + cost > max_chars:
            out.append(current)
            current, size = [], 0
        current.append(item)
        size += cost
    if current:
        out.append(current)
    return out


def clean_citations(raw: Any, known: set[str]) -> list[str]:
    """Keeps only citations to ids present in the input, without duplicates, in order."""
    if isinstance(raw, (str, int)) and not isinstance(raw, bool):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for value in raw:
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            continue
        key = str(value).strip()
        if key in known and key not in out:
            out.append(key)
    return out


def clean_line(value: Any, limit: int) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def clean_block(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    lines = [" ".join(line.split()) for line in value.strip().splitlines()]
    return "\n".join(lines)[:limit].strip()


def _entries(raw: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, list):
            return value
    return []


def _hint_from_items(hint: Any, cited: list[Item]) -> str | None:
    """An assignee hint survives only if it is written in a cited item (text or author)."""
    name = clean_line(hint, 200)
    if not name:
        return None
    needle = name.casefold()
    for item in cited:
        if needle in item.text.casefold() or needle in item.author.casefold():
            return name
    return None


class _Merger:
    """Collects entries from several batches; the same text merges its citations."""

    def __init__(self) -> None:
        self.order: list[str] = []
        self.entries: dict[str, dict[str, Any]] = {}

    def add(self, text: str, citations: list[str], **extra: Any) -> None:
        key = text.casefold()
        if key in self.entries:
            known = self.entries[key]["citations"]
            known.extend(c for c in citations if c not in known)
            return
        self.order.append(key)
        self.entries[key] = {"text": text, "citations": list(citations), **extra}

    def values(self, limit: int) -> list[dict[str, Any]]:
        return [self.entries[key] for key in self.order[:limit]]


def _batches_or_fail(items: list[Item], max_chars: int) -> list[list[Item]]:
    groups = batches(items, max_chars)
    if len(groups) > MAX_BATCHES:
        raise ApiError(422, "input_too_large", "Too much text for one request; send fewer items.")
    return groups


async def summarize(chat: ChatModel, req: SummarizeRequest, max_prompt_chars: int = MAX_PROMPT_CHARS) -> SummarizeResponse:
    system = prompts.summarize_system(req.kind, req.locale)
    by_id = {item.id: item for item in req.items}
    decisions, actions = _Merger(), _Merger()
    dropped = Dropped()
    partials: list[str] = []

    for batch in _batches_or_fail(req.items, max_prompt_chars):
        known = {item.id for item in batch}
        raw = await chat.chat_json(
            [{"role": "system", "content": system}, {"role": "user", "content": render_items(batch)}]
        )
        partials.append(clean_block(raw.get("summary"), MAX_SUMMARY_CHARS))

        for entry in _entries(raw, "decisions"):
            entry = entry if isinstance(entry, dict) else {}
            text = clean_line(entry.get("text"), MAX_ENTRY_CHARS)
            citations = clean_citations(entry.get("citations"), known)
            if not text or not citations:
                dropped.decisions += 1
                continue
            decisions.add(text, citations)

        for entry in _entries(raw, "actionItems", "action_items"):
            entry = entry if isinstance(entry, dict) else {}
            text = clean_line(entry.get("text"), MAX_ENTRY_CHARS)
            citations = clean_citations(entry.get("citations"), known)
            if not text or not citations:
                dropped.action_items += 1
                continue
            hint = _hint_from_items(entry.get("assigneeHint", entry.get("assignee_hint")), [by_id[c] for c in citations])
            actions.add(text, citations, assignee_hint=hint)

    summary = partials[0] if len(partials) == 1 else await _combine(chat, req, partials, max_prompt_chars)
    return SummarizeResponse(
        summary=summary,
        decisions=[Decision(**entry) for entry in decisions.values(MAX_ENTRIES)],
        action_items=[ActionItem(**entry) for entry in actions.values(MAX_ENTRIES)],
        model=chat.model,
        dropped=dropped,
    )


async def _combine(chat: ChatModel, req: SummarizeRequest, parts: list[str], max_chars: int) -> str:
    """Combines partial summaries in groups until one summary is left."""
    system = prompts.combine_system(req.kind, req.locale)
    parts = [p for p in parts if p]
    while len(parts) > 1:
        groups: list[list[str]] = []
        current: list[str] = []
        size = 0
        for part in parts:
            if current and size + len(part) > max_chars:
                groups.append(current)
                current, size = [], 0
            current.append(part)
            size += len(part)
        groups.append(current)
        if len(groups) == len(parts):  # every part is large: still make progress, two at a time
            groups = [parts[i : i + 2] for i in range(0, len(parts), 2)]
        combined = []
        for group in groups:
            if len(group) == 1:
                combined.append(group[0])
                continue
            text = "\n\n".join(f"Part {i + 1}:\n{part}" for i, part in enumerate(group))
            raw = await chat.chat_json([{"role": "system", "content": system}, {"role": "user", "content": text}])
            combined.append(clean_block(raw.get("summary"), MAX_SUMMARY_CHARS))
        parts = [p for p in combined if p]
    return parts[0] if parts else ""


async def suggest_tasks(chat: ChatModel, req: SuggestTasksRequest, max_prompt_chars: int = MAX_PROMPT_CHARS) -> SuggestTasksResponse:
    system = prompts.suggest_system(req.locale)
    merged = _Merger()
    dropped = 0
    for batch in _batches_or_fail(req.items, max_prompt_chars):
        known = {item.id for item in batch}
        raw = await chat.chat_json(
            [{"role": "system", "content": system}, {"role": "user", "content": render_items(batch)}]
        )
        for entry in _entries(raw, "suggestions"):
            entry = entry if isinstance(entry, dict) else {}
            title = clean_line(entry.get("title"), 200)
            citations = clean_citations(entry.get("citations"), known)
            if not title or not citations:
                dropped += 1
                continue
            merged.add(title, citations, description=clean_block(entry.get("description"), 2000))
    suggestions = [
        Suggestion(title=e["text"], description=e["description"], citations=e["citations"])
        for e in merged.values(MAX_SUGGESTIONS)
    ]
    return SuggestTasksResponse(suggestions=suggestions, model=chat.model, dropped=dropped)
