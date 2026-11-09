"""Signature checks: every route except GET /healthz needs a valid, fresh HMAC over the
timestamp, the method, the request target and the body."""

from __future__ import annotations

import hashlib
import hmac
import json
import time

from conftest import SECRET, error_code, make_settings, running

from fudislte_ai.auth import compute_signature, sign_headers, signed_prefix

SUMMARY_BODY = {"kind": "meeting", "locale": "en", "items": [{"id": "1", "text": "hi"}]}


def test_signature_test_vectors() -> None:
    # The same vectors are published in docs/architecture/ai-worker.md for the Go side.
    secret = b"0123456789abcdef0123456789abcdef"
    body = b'{"hello":"world"}'
    assert signed_prefix("1767225600", "POST", "/v1/summarize") + body == b'1767225600.POST./v1/summarize.{"hello":"world"}'
    assert (
        compute_signature(secret, "1767225600", "POST", "/v1/summarize", body)
        == "v1=285f6e5651d72488cf206fc8c15018852981cc64e4fc6400cfffecde0a121c1e"
    )
    # Bodiless request with a query string; the method is upper-cased.
    assert signed_prefix("1767225600", "get", "/v1/agents/runs/abc?x=1") == b"1767225600.GET./v1/agents/runs/abc?x=1."
    assert (
        compute_signature(secret, "1767225600", "GET", "/v1/agents/runs/abc?x=1", b"")
        == "v1=a56d00d3ffbff6dbb26b579f1fac6d808b645c2cc96ad6368b216849fb0d504e"
    )


def test_healthz_needs_no_signature_and_reports_capabilities() -> None:
    with running() as w:
        r = w.client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["capabilities"] == {"llm": False, "embeddings": False, "transcription": False}
        assert body["llm"] == {"kind": "none", "external": False}


def test_unsigned_requests_are_rejected() -> None:
    with running() as w:
        r = w.client.post("/v1/summarize", json={})
        assert r.status_code == 401
        assert error_code(r) == "signature_missing"
        # Unknown routes do not reveal themselves either.
        assert w.client.get("/v1/nothing-here").status_code == 401
        # /healthz is exempt only for GET.
        assert w.client.post("/healthz").status_code == 401


def test_valid_signature_reaches_the_route() -> None:
    with running() as w:
        r = w.post("/v1/summarize", SUMMARY_BODY)
        assert r.status_code == 503
        assert error_code(r) == "capability_disabled"
        # A signed request for a route that does not exist is a normal 404.
        assert w.get("/v1/nothing-here").status_code == 404


def test_wrong_secret_and_altered_body_are_rejected() -> None:
    with running() as w:
        body = json.dumps({"kind": "meeting"}).encode()
        headers = sign_headers(b"another-secret-0123456789abcdef-012345", "POST", "/v1/summarize", body)
        r = w.client.post("/v1/summarize", content=body, headers=headers)
        assert r.status_code == 401 and error_code(r) == "signature_invalid"

        headers = sign_headers(SECRET, "POST", "/v1/summarize", body)
        r = w.client.post("/v1/summarize", content=body + b" ", headers=headers)
        assert r.status_code == 401 and error_code(r) == "signature_invalid"


def test_signature_binds_method_path_and_query() -> None:
    with running() as w:
        run = "/v1/agents/runs/a"
        # The genuine request passes authentication (and then finds no such run).
        assert error_code(w.get(run)) == "run_not_found"
        # The same signature replayed with another method, path or query string fails.
        assert error_code(w.request("DELETE", run, sign_as=("GET", run))) == "signature_invalid"
        assert error_code(w.request("POST", run, sign_as=("GET", run))) == "signature_invalid"
        assert error_code(w.get("/v1/agents/runs/b", sign_as=("GET", run))) == "signature_invalid"
        assert error_code(w.get(run + "?x=1", sign_as=("GET", run))) == "signature_invalid"
        assert error_code(w.get(run + "?x=2", sign_as=("GET", run + "?x=1"))) == "signature_invalid"
        assert error_code(w.get(run, sign_as=("GET", run + "?x=1"))) == "signature_invalid"
        # With the query string signed, the request passes authentication.
        assert error_code(w.get(run + "?x=1")) == "run_not_found"

        # The target is the raw path as sent, not the decoded path.
        assert error_code(w.get("/v1/agents/runs/a%20b", sign_as=("GET", "/v1/agents/runs/a b"))) == "signature_invalid"
        assert error_code(w.get("/v1/agents/runs/a%20b")) == "run_not_found"

        # A signed body cannot be replayed to another endpoint that accepts the same body.
        approve = {"actionId": "x", "hash": "0" * 64, "approvedBy": "u"}
        r = w.post("/v1/agents/runs/r1/reject", approve, sign_as=("POST", "/v1/agents/runs/r1/approve"))
        assert error_code(r) == "signature_invalid"
        r = w.post("/v1/suggest-tasks", SUMMARY_BODY, sign_as=("POST", "/v1/summarize"))
        assert error_code(r) == "signature_invalid"


def test_timestamp_skew_limit() -> None:
    with running() as w:
        now = time.time()
        assert error_code(w.post("/v1/summarize", {}, now=now - 301)) == "timestamp_expired"
        assert error_code(w.post("/v1/summarize", {}, now=now + 301)) == "timestamp_expired"
        # 290 seconds old is still accepted (then fails validation, i.e. auth passed).
        assert w.post("/v1/summarize", {}, now=now - 290).status_code == 422


def test_malformed_timestamp_and_signature_version() -> None:
    with running() as w:
        body = b"{}"
        ts = str(int(time.time()))
        good = compute_signature(SECRET, ts, "POST", "/v1/summarize", body)
        r = w.client.post(
            "/v1/summarize",
            content=body,
            headers={"X-FUDISLTE-Timestamp": ts + ".5", "X-FUDISLTE-Signature": good},
        )
        assert error_code(r) == "timestamp_invalid"
        r = w.client.post(
            "/v1/summarize",
            content=body,
            headers={"X-FUDISLTE-Timestamp": ts, "X-FUDISLTE-Signature": good.replace("v1=", "v2=")},
        )
        assert error_code(r) == "signature_invalid"
        # The old body-only scheme (timestamp + "." + body) is no longer accepted.
        legacy ="v1=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
        r = w.client.post("/v1/summarize", content=body, headers={"X-FUDISLTE-Timestamp": ts, "X-FUDISLTE-Signature": legacy})
        assert error_code(r) == "signature_invalid"
        # A correct request with these exact headers passes authentication.
        r = w.client.post("/v1/summarize", content=body, headers={"X-FUDISLTE-Timestamp": ts, "X-FUDISLTE-Signature": good})
        assert r.status_code == 422


def test_body_size_limit() -> None:
    with running(make_settings(max_body_bytes=1024)) as w:
        r = w.post("/v1/summarize", {"items": [{"id": "1", "text": "x" * 2000}]})
        assert r.status_code == 413
        assert error_code(r) == "body_too_large"


def test_empty_body_requests_sign_method_and_target() -> None:
    with running() as w:
        r = w.get("/v1/agents/runs/does-not-exist")
        assert r.status_code == 404
        assert error_code(r) == "run_not_found"
