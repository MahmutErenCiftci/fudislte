"""Indexing and permission-aware search against a real PostgreSQL + pgvector database.

scripts/wsl/ai-test.sh creates a throwaway database and sets FUDISLTE_AI_TEST_DATABASE_URL;
without it these tests are skipped.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from conftest import TEST_DSN, FakeEmbedder, embed_text, error_code, running

from fudislte_ai.store import PgVectorStore, StoreError

pytestmark = pytest.mark.skipif(not TEST_DSN, reason="FUDISLTE_AI_TEST_DATABASE_URL is not set")

T1 = "2026-10-30T10:00:00Z"
T2 = "2026-10-30T11:00:00Z"


def new_store() -> PgVectorStore:
    return PgVectorStore(TEST_DSN, FakeEmbedder.model, FakeEmbedder.dim)


def doc(org: str, source_id: str, acl: str, text: str, updated: str = T1, title: str = "") -> dict:
    return {
        "orgId": org,
        "sourceType": "message",
        "sourceId": source_id,
        "aclId": acl,
        "title": title,
        "text": text,
        "updatedAt": updated,
    }


def search(w, org: str, query: str, allowed: list[str], limit: int = 10) -> list[dict]:
    r = w.post("/v1/search", {"orgId": org, "query": query, "allowedAclIds": allowed, "limit": limit})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_search_returns_only_allowed_acls() -> None:
    org, other_org = f"org-{uuid.uuid4()}", f"org-{uuid.uuid4()}"
    with running(embedder=FakeEmbedder(), store=new_store()) as w:
        assert w.client.get("/healthz").json()["capabilities"]["embeddings"] is True
        for body in (
            doc(org, "a", "channel:general", "budget forecast for next quarter"),
            doc(org, "b", "channel:management", "budget forecast salaries are confidential"),
            doc(org, "c", "room:hr", "budget forecast for hiring plans"),
            doc(other_org, "d", "channel:general", "budget forecast of another company"),
        ):
            r = w.post("/v1/index", body)
            assert r.status_code == 200, r.text
            assert r.json() == {"status": "indexed", "chunks": 1}

        assert {h["sourceId"] for h in search(w, org, "budget forecast", ["channel:general"])} == {"a"}
        assert {h["sourceId"] for h in search(w, org, "budget forecast", ["channel:management"])} == {"b"}
        both = search(w, org, "budget forecast", ["channel:general", "room:hr"])
        assert {h["sourceId"] for h in both} == {"a", "c"}
        assert all(h["aclId"] in {"channel:general", "room:hr"} for h in both)
        # Nothing allowed means nothing found, and other workspaces never leak in.
        assert search(w, org, "budget forecast", []) == []
        assert {h["sourceId"] for h in search(w, other_org, "budget forecast", ["channel:general", "channel:management"])} == {"d"}
        # Unknown ACL ids simply match nothing.
        assert search(w, org, "budget forecast", ["channel:unknown"]) == []

        hit = search(w, org, "budget forecast", ["channel:general"])[0]
        assert set(hit) == {"sourceType", "sourceId", "chunk", "aclId", "title", "text", "score", "updatedAt"}
        assert hit["text"] == "budget forecast for next quarter"


def test_acl_filter_is_applied_inside_the_query() -> None:
    """The closest chunk is not allowed; a post-filter after LIMIT 1 would return nothing.
    Filtering in SQL (with pgvector's iterative index scan) still finds the allowed one."""
    org = f"org-{uuid.uuid4()}"

    async def scenario() -> list:
        store = new_store()
        await store.open()
        try:
            for i in range(40):
                text = f"secret salary review {i}"
                await store.replace(
                    org_id=org, source_type="message", source_id=f"s{i}", acl_id="room:secret",
                    title="", updated_at=_dt(T1), chunks=[text], embeddings=[embed_text(text)],
                )
            text = "lunch menu for friday"
            await store.replace(
                org_id=org, source_type="message", source_id="open", acl_id="channel:general",
                title="", updated_at=_dt(T1), chunks=[text], embeddings=[embed_text(text)],
            )
            return await store.search(org, embed_text("secret salary review 3"), ["channel:general"], 1)
        finally:
            await store.close()

    hits = asyncio.run(scenario())
    assert [(h.source_id, h.acl_id) for h in hits] == [("open", "channel:general")]


def test_reindex_replaces_chunks_and_ignores_stale_updates() -> None:
    org = f"org-{uuid.uuid4()}"
    long_text = " ".join(f"Paragraph {n} talks about the roadmap and the release plan." for n in range(80))
    with running(embedder=FakeEmbedder(), store=new_store()) as w:
        r = w.post("/v1/index", doc(org, "doc1", "doc:1", long_text, updated=T1, title="Roadmap"))
        assert r.json()["status"] == "indexed" and r.json()["chunks"] > 1

        r = w.post("/v1/index", doc(org, "doc1", "doc:1", "Short replacement text.", updated=T2, title="Roadmap"))
        assert r.json() == {"status": "indexed", "chunks": 1}
        hits = search(w, org, "replacement", ["doc:1"])
        assert [h["text"] for h in hits] == ["Short replacement text."]
        assert hits[0]["title"] == "Roadmap"

        # An older version arriving late does not overwrite the newer one.
        r = w.post("/v1/index", doc(org, "doc1", "doc:1", "Old text from before.", updated=T1))
        assert r.json() == {"status": "stale", "chunks": 0}
        assert [h["text"] for h in search(w, org, "text", ["doc:1"])] == ["Short replacement text."]

        # Moving a source to another ACL takes effect on re-index.
        w.post("/v1/index", doc(org, "doc1", "doc:restricted", "Short replacement text.", updated=T2))
        assert search(w, org, "replacement", ["doc:1"]) == []


def test_delete_one_source_and_a_whole_workspace() -> None:
    org = f"org-{uuid.uuid4()}"
    with running(embedder=FakeEmbedder(), store=new_store()) as w:
        for sid in ("x", "y"):
            w.post("/v1/index", doc(org, sid, "channel:general", f"note {sid} about deployments"))
        r = w.delete("/v1/index", {"orgId": org, "sourceType": "message", "sourceId": "x"})
        assert r.status_code == 200 and r.json() == {"deleted": 1}
        assert {h["sourceId"] for h in search(w, org, "deployments", ["channel:general"])} == {"y"}
        r = w.delete("/v1/index", {"orgId": org})
        assert r.json() == {"deleted": 1}
        assert search(w, org, "deployments", ["channel:general"]) == []
        r = w.delete("/v1/index", {"orgId": org, "sourceType": "message"})
        assert r.status_code == 422


def test_index_validation() -> None:
    with running(embedder=FakeEmbedder(), store=new_store()) as w:
        r = w.post("/v1/index", {**doc("o", "s", "a", ""), "title": ""})
        assert r.status_code == 422
        r = w.post("/v1/index", {**doc("o", "s", "a", "text"), "updatedAt": "2026-10-30T10:00:00"})
        assert r.status_code == 422  # timestamps must carry a time zone
        r = w.post("/v1/index", {**doc("o", "s", "a", "text"), "sourceType": "Bad Type"})
        assert r.status_code == 422


def test_model_change_is_refused() -> None:
    async def scenario() -> None:
        store = PgVectorStore(TEST_DSN, "another-model", FakeEmbedder.dim)
        await store.open(attempts=1)

    # The table was created for fake-embed by earlier tests (or is created now).
    asyncio.run(_open_and_close(new_store()))
    with pytest.raises(StoreError, match="cannot be mixed"):
        asyncio.run(scenario())


def test_retrieval_disabled_without_store() -> None:
    with running() as w:
        r = w.post("/v1/search", {"orgId": "o", "query": "q", "allowedAclIds": ["a"]})
        assert r.status_code == 503 and error_code(r) == "capability_disabled"
        r = w.delete("/v1/index", {"orgId": "o"})
        assert r.status_code == 503


async def _open_and_close(store: PgVectorStore) -> None:
    await store.open()
    await store.close()


def _dt(value: str):
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00"))
