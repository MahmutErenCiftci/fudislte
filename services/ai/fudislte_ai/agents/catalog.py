"""The tools agents may use and which agent gets which.

Each tool maps to one FUDISLTE API callback (`POST /internal/ai/tools/{name}`). Tools for
features FUDISLTE does not have yet (projects, Git activity, widgets, whiteboards) are part
of the contract already; until the API implements them it answers `tool_unavailable`
and the agent says it could not do that.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from .tools import ArgModel, Tool, ToolRegistry

Ref = Annotated[str, StringConstraints(min_length=1, max_length=128)]
SourceType = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_.-]{0,63}$")]


class SearchArgs(ArgModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=8, ge=1, le=20)


class GetItemArgs(ArgModel):
    source_type: SourceType
    source_id: Ref


class ListChannelMessagesArgs(ArgModel):
    channel_id: Ref
    limit: int = Field(default=50, ge=1, le=200)
    before: Ref | None = None


class ListTasksArgs(ArgModel):
    project_id: Ref | None = None
    query: str | None = Field(default=None, max_length=200)
    status: str | None = Field(default=None, max_length=40)
    limit: int = Field(default=50, ge=1, le=200)


class CreateTaskArgs(ArgModel):
    project_id: Ref
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    assignee_id: Ref | None = None
    due_date: date | None = None


class UpdateTaskArgs(ArgModel):
    task_id: Ref
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    status: str | None = Field(default=None, min_length=1, max_length=40)
    assignee_id: Ref | None = None
    due_date: date | None = None

    @model_validator(mode="after")
    def _changes_something(self):
        if all(
            getattr(self, f) is None for f in ("title", "description", "status", "assignee_id", "due_date")
        ):
            raise ValueError("set at least one field to change")
        return self


class PostMessageArgs(ArgModel):
    channel_id: Ref
    text: str = Field(min_length=1, max_length=4000)
    thread_id: Ref | None = None


class ListGitActivityArgs(ArgModel):
    project_id: Ref | None = None
    limit: int = Field(default=30, ge=1, le=100)


class QueryWidgetArgs(ArgModel):
    widget_id: Ref


class GetWhiteboardArgs(ArgModel):
    board_id: Ref


class WhiteboardElement(ArgModel):
    type: Literal["text", "sticky", "rectangle", "ellipse", "arrow"]
    text: str = Field(default="", max_length=500)
    x: int = Field(ge=-100_000, le=100_000)
    y: int = Field(ge=-100_000, le=100_000)
    width: int | None = Field(default=None, ge=1, le=10_000)
    height: int | None = Field(default=None, ge=1, le=10_000)


class AddWhiteboardElementsArgs(ArgModel):
    board_id: Ref
    elements: list[WhiteboardElement] = Field(min_length=1, max_length=50)


class GetMeetingArgs(ArgModel):
    meeting_id: Ref


TOOLS = [
    Tool("search", "Permission-aware search across what the person can read (messages, documents, tasks). Returns items with sourceType, sourceId, title and text.", SearchArgs, False),
    Tool("get_item", "Read one item the person can read, by sourceType and sourceId.", GetItemArgs, False),
    Tool("list_channel_messages", "Recent messages of a channel the person can read.", ListChannelMessagesArgs, False),
    Tool("list_tasks", "Tasks the person can see, optionally filtered by project, text or status.", ListTasksArgs, False),
    Tool("list_git_activity", "Recent pull requests, commits and CI results linked to projects the person can see.", ListGitActivityArgs, False),
    Tool("query_widget", "Current data of a dashboard widget the person can see.", QueryWidgetArgs, False),
    Tool("get_whiteboard", "Elements of a whiteboard the person can read.", GetWhiteboardArgs, False),
    Tool("get_meeting", "A meeting's details and transcript, if the person attended or may read it.", GetMeetingArgs, False),
    Tool("create_task", "Create a task in a project.", CreateTaskArgs, True),
    Tool("update_task", "Change a task's title, description, status, assignee or due date.", UpdateTaskArgs, True),
    Tool("post_message", "Post a message, as the person, in a channel or thread.", PostMessageArgs, True),
    Tool("add_whiteboard_elements", "Add text, sticky notes, shapes or arrows to a whiteboard.", AddWhiteboardElementsArgs, True),
]

AGENT_TOOLS = {
    "research": ["search", "get_item"],
    "developer": ["search", "get_item", "list_git_activity", "list_tasks", "create_task", "update_task"],
    "project": ["search", "get_item", "list_tasks", "list_channel_messages", "create_task", "update_task", "post_message"],
    "data": ["search", "get_item", "query_widget"],
    "whiteboard": ["search", "get_item", "get_whiteboard", "add_whiteboard_elements"],
    "voice": ["get_meeting", "search", "get_item", "create_task", "post_message"],
}

AGENTS = tuple(AGENT_TOOLS)


def default_registry() -> ToolRegistry:
    return ToolRegistry(TOOLS, AGENT_TOOLS)
