"""Tool registry: every tool has a JSON schema, a `destructive` flag and nothing else.

Tools are descriptions; the work is done by the FUDISLTE API (see client.py), which checks
the delegating person's permissions like for any other request. There is deliberately no
way to register a handler that runs code, touches files or opens network connections.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel


class ToolArgumentError(ValueError):
    pass


class ArgModel(BaseModel):
    """Base for tool arguments: camelCase, unknown fields rejected, no floats used."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[ArgModel]
    destructive: bool

    @property
    def schema(self) -> dict[str, Any]:
        return self.args.model_json_schema(by_alias=True)

    def validate(self, arguments: Any) -> dict[str, Any]:
        """Returns the arguments in canonical form (defaults filled, nulls removed)."""
        if not isinstance(arguments, dict):
            raise ToolArgumentError("arguments must be a JSON object")
        try:
            parsed = self.args.model_validate(arguments)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in err['loc']) or 'arguments'}: {err['msg']}" for err in exc.errors()[:5]
            )
            raise ToolArgumentError(problems) from None
        return parsed.model_dump(mode="json", by_alias=True, exclude_none=True)

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "destructive": self.destructive,
            "schema": self.schema,
        }


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, ASCII only (non-ASCII as lowercase \\uXXXX escapes)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def action_hash(tool: str, arguments: dict[str, Any]) -> str:
    """Hex SHA-256 of `tool + "\\n" + canonical_json(arguments)` (UTF-8)."""
    return hashlib.sha256(f"{tool}\n{canonical_json(arguments)}".encode()).hexdigest()


class ToolRegistry:
    def __init__(self, tools: list[Tool], agents: dict[str, list[str]]) -> None:
        self.tools = {tool.name: tool for tool in tools}
        if len(self.tools) != len(tools):
            raise ValueError("duplicate tool name")
        for agent, names in agents.items():
            missing = [n for n in names if n not in self.tools]
            if missing:
                raise ValueError(f"agent {agent} uses unknown tools {missing}")
        self.agents = agents

    def for_agent(self, agent: str) -> list[Tool]:
        return [self.tools[name] for name in self.agents.get(agent, [])]

    def get(self, agent: str, name: Any) -> Tool | None:
        """The tool if this agent may use it; None for unknown or foreign tools."""
        if not isinstance(name, str) or name not in self.agents.get(agent, []):
            return None
        return self.tools[name]

    def prompt_text(self, agent: str) -> str:
        lines = []
        for tool in self.for_agent(agent):
            mode = "requires approval" if tool.destructive else "read-only"
            schema = json.dumps(tool.schema, separators=(",", ":"), ensure_ascii=False)
            lines.append(f"- {tool.name} ({mode}): {tool.description}\n  arguments schema: {schema}")
        return "\n".join(lines)

    def catalog(self) -> dict[str, Any]:
        return {
            "agents": [
                {"agent": agent, "tools": [tool.describe() for tool in self.for_agent(agent)]}
                for agent in self.agents
            ]
        }
