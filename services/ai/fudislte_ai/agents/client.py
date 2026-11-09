"""The only way agent tools act: calls back to the FUDISLTE API as the delegating person.

    POST {FUDISLTE_AI_API_URL}/internal/ai/tools/{tool}
    Authorization: Bearer <per-run delegated token from the run request>
    X-FUDISLTE-Timestamp / X-FUDISLTE-Signature: same HMAC scheme as API -> worker, over
        timestamp, "POST", the request target as sent (e.g. /internal/ai/tools/search)
        and the body
    X-FUDISLTE-Approval-Action / X-FUDISLTE-Approval-Hash: only for approved destructive tools
    {"runId", "orgId", "userId", "agent", "tool", "arguments"}

The base URL is fixed configuration; nothing a model writes can change where a request
goes. Redirects are not followed and responses are size-limited.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from ..auth import sign_headers

MAX_RESPONSE_BYTES = 256 << 10


class ToolCallError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ApprovalProof:
    action_id: str
    hash: str
    approved_by: str


class FudislteClient(Protocol):
    async def call_tool(self, tool: str, arguments: dict[str, Any], *, approval: ApprovalProof | None = None) -> Any: ...


class HttpFudislteClient:
    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        base_url: str,
        secret: bytes,
        token: str,
        run_id: str,
        org_id: str,
        user_id: str,
        agent: str,
        timeout: float = 30.0,
    ) -> None:
        self.http = http
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self.token = token
        self.context = {"runId": run_id, "orgId": org_id, "userId": user_id, "agent": agent}
        self.timeout = timeout

    async def call_tool(self, tool: str, arguments: dict[str, Any], *, approval: ApprovalProof | None = None) -> Any:
        body = json.dumps({**self.context, "tool": tool, "arguments": arguments}, ensure_ascii=False).encode()
        url = httpx.URL(f"{self.base_url}/internal/ai/tools/{quote(tool, safe='')}")
        headers = {
            # raw_path is the request target httpx sends: path plus "?query" if any.
            **sign_headers(self.secret, "POST", url.raw_path, body),
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        if approval is not None:
            headers["X-FUDISLTE-Approval-Action"] = approval.action_id
            headers["X-FUDISLTE-Approval-Hash"] = approval.hash
        try:
            async with self.http.stream(
                "POST", url, content=body, headers=headers, timeout=self.timeout, follow_redirects=False
            ) as response:
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise ToolCallError("result_too_large", "The tool result is too large.")
                status = response.status_code
        except httpx.HTTPError as exc:
            raise ToolCallError("api_unreachable", f"FUDISLTE API unreachable ({type(exc).__name__})") from None

        try:
            payload = json.loads(data) if data else None
        except ValueError:
            payload = None
        if 200 <= status < 300:
            return payload
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict) and isinstance(error.get("code"), str):
            raise ToolCallError(error["code"], str(error.get("message", ""))[:500])
        raise ToolCallError("api_error", f"FUDISLTE API answered HTTP {status}")
