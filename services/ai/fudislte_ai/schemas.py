"""JSON request and response shapes (camelCase on the wire, like the FUDISLTE API)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

Id = Annotated[str, StringConstraints(min_length=1, max_length=128)]
AclId = Annotated[str, StringConstraints(min_length=1, max_length=256)]
SourceType = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_.-]{0,63}$")]
Locale = Literal["tr", "en"]

MAX_ITEMS = 5000


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Item(Model):
    """One message or transcript segment: the unit that summaries cite."""

    id: Id
    at: datetime | None = None
    author: str = Field(default="", max_length=200)
    text: str = Field(max_length=20000)


class _ItemsRequest(Model):
    items: list[Item] = Field(min_length=1, max_length=MAX_ITEMS)

    @model_validator(mode="after")
    def _unique_ids(self):
        ids = [item.id for item in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError("item ids must be unique")
        return self


class SummarizeRequest(_ItemsRequest):
    kind: Literal["meeting", "channel"]
    locale: Locale


class Decision(Model):
    text: str
    citations: list[str]


class ActionItem(Model):
    text: str
    citations: list[str]
    assignee_hint: str | None = None


class Dropped(Model):
    decisions: int = 0
    action_items: int = 0


class SummarizeResponse(Model):
    summary: str
    decisions: list[Decision]
    action_items: list[ActionItem]
    model: str
    dropped: Dropped


class SuggestTasksRequest(_ItemsRequest):
    org_id: Id
    locale: Locale


class Suggestion(Model):
    title: str
    description: str
    citations: list[str]


class SuggestTasksResponse(Model):
    suggestions: list[Suggestion]
    model: str
    dropped: int


class IndexRequest(Model):
    org_id: Id
    source_type: SourceType
    source_id: Id
    acl_id: AclId
    title: str = Field(default="", max_length=500)
    text: str = Field(max_length=1_000_000)
    updated_at: AwareDatetime

    @model_validator(mode="after")
    def _has_content(self):
        if not self.title.strip() and not self.text.strip():
            raise ValueError("title or text must not be empty")
        return self


class IndexResponse(Model):
    status: Literal["indexed", "stale"]
    chunks: int


class DeleteIndexRequest(Model):
    """Deletes one source, or with only orgId every chunk of that workspace."""

    org_id: Id
    source_type: SourceType | None = None
    source_id: Id | None = None

    @model_validator(mode="after")
    def _both_or_neither(self):
        if (self.source_type is None) != (self.source_id is None):
            raise ValueError("sourceType and sourceId go together")
        return self


class DeleteIndexResponse(Model):
    deleted: int


class SearchRequest(Model):
    org_id: Id
    query: str = Field(min_length=1, max_length=2000)
    allowed_acl_ids: list[AclId] = Field(max_length=20000)
    limit: int = Field(default=10, ge=1, le=50)


class SearchResult(Model):
    source_type: str
    source_id: str
    chunk: int
    acl_id: str
    title: str
    text: str
    score: float
    updated_at: datetime


class SearchResponse(Model):
    results: list[SearchResult]


class Segment(Model):
    start: float
    end: float
    text: str


class TranscribeResponse(Model):
    language: str | None
    duration: float | None
    segments: list[Segment]
