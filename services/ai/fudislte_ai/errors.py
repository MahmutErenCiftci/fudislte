"""Errors in the same JSON shape as the FUDISLTE API: {"error": {"code", "message", "fields"}}."""

from __future__ import annotations


class ApiError(Exception):
    """An error that is safe to return to the caller (the FUDISLTE API)."""

    def __init__(self, status: int, code: str, message: str, fields: dict[str, str] | None = None):
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields

    def body(self) -> dict:
        return error_body(self.code, self.message, self.fields)


def error_body(code: str, message: str, fields: dict[str, str] | None = None) -> dict:
    error: dict = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return {"error": error}


def capability_disabled(capability: str) -> ApiError:
    return ApiError(
        503,
        "capability_disabled",
        f"The {capability} capability is not enabled on this AI worker.",
    )
