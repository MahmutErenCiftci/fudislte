"""Permission-aware vector index in PostgreSQL with pgvector.

The worker never decides who may read what. Every chunk carries the `aclId` the API gave
it, and a search returns only chunks whose aclId is in the caller-supplied
`allowedAclIds` — the filter is part of the SQL query, not applied afterwards.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime

import asyncpg

log = logging.getLogger("fudislte_ai.store")

# One lock id for schema changes, so several workers can start at the same time.
_SCHEMA_LOCK = 0x6664_6169  # "fdai"


class StoreError(Exception):
    pass


@dataclass(frozen=True)
class Hit:
    source_type: str
    source_id: str
    chunk: int
    acl_id: str
    title: str
    text: str
    score: float
    updated_at: datetime


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


class PgVectorStore:
    def __init__(self, dsn: str, embed_model: str, embed_dim: int, *, min_pool: int = 1, max_pool: int = 5) -> None:
        self.dsn = dsn
        self.embed_model = embed_model
        self.embed_dim = int(embed_dim)
        self.min_pool = min_pool
        self.max_pool = max_pool
        self.pool: asyncpg.Pool | None = None
        self.iterative_scan = False

    async def open(self, attempts: int = 5, delay: float = 2.0) -> None:
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                self.pool = await asyncpg.create_pool(
                    self.dsn, min_size=self.min_pool, max_size=self.max_pool, command_timeout=60
                )
                break
            except (OSError, asyncpg.PostgresError) as exc:
                last = exc
                if attempt + 1 < attempts:
                    await asyncio.sleep(delay)
        if self.pool is None:
            raise StoreError(f"cannot connect to FUDISLTE_AI_DATABASE_URL ({type(last).__name__})")
        try:
            await self._migrate()
        except Exception:
            await self.close()
            raise

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def _migrate(self) -> None:
        dim = self.embed_dim
        async with self._pool().acquire() as con:
            await con.execute("SELECT pg_advisory_lock($1)", _SCHEMA_LOCK)
            try:
                await con.execute("CREATE EXTENSION IF NOT EXISTS vector")
                await con.execute(
                    """
                    CREATE TABLE IF NOT EXISTS ai_index_meta (
                      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
                      embed_model text NOT NULL,
                      embed_dim integer NOT NULL,
                      created_at timestamptz NOT NULL DEFAULT now()
                    )
                    """
                )
                row = await con.fetchrow("SELECT embed_model, embed_dim FROM ai_index_meta")
                if row is None:
                    await con.execute(
                        "INSERT INTO ai_index_meta (embed_model, embed_dim) VALUES ($1, $2)",
                        self.embed_model,
                        dim,
                    )
                elif (row["embed_model"], row["embed_dim"]) != (self.embed_model, dim):
                    raise StoreError(
                        f"the index was built with {row['embed_model']} ({row['embed_dim']} dimensions), "
                        f"not {self.embed_model} ({dim}). Vectors from different models cannot be mixed: "
                        "drop the tables ai_chunks and ai_index_meta and let FUDISLTE re-index"
                    )
                await con.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS ai_chunks (
                      org_id text NOT NULL,
                      source_type text NOT NULL,
                      source_id text NOT NULL,
                      chunk_no integer NOT NULL,
                      acl_id text NOT NULL,
                      title text NOT NULL,
                      content text NOT NULL,
                      source_updated_at timestamptz NOT NULL,
                      indexed_at timestamptz NOT NULL DEFAULT now(),
                      embedding vector({dim}) NOT NULL,
                      PRIMARY KEY (org_id, source_type, source_id, chunk_no)
                    )
                    """
                )
                await con.execute("CREATE INDEX IF NOT EXISTS ai_chunks_org_acl_idx ON ai_chunks (org_id, acl_id)")
                await con.execute(
                    "CREATE INDEX IF NOT EXISTS ai_chunks_embedding_idx ON ai_chunks "
                    "USING hnsw (embedding vector_cosine_ops)"
                )
                version = await con.fetchval("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            finally:
                await con.execute("SELECT pg_advisory_unlock($1)", _SCHEMA_LOCK)
        # Iterative index scans (pgvector 0.8+) keep filtered searches from returning
        # fewer rows than asked when most nearest neighbours are filtered out.
        major, minor = (int(x) for x in str(version).split(".")[:2])
        self.iterative_scan = (major, minor) >= (0, 8)
        log.info("vector index ready (pgvector %s, model %s, %d dimensions)", version, self.embed_model, dim)

    def _pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise StoreError("the vector store is not open")
        return self.pool

    async def is_stale(self, org_id: str, source_type: str, source_id: str, updated_at: datetime) -> bool:
        current = await self._pool().fetchval(
            "SELECT max(source_updated_at) FROM ai_chunks WHERE org_id = $1 AND source_type = $2 AND source_id = $3",
            org_id,
            source_type,
            source_id,
        )
        return current is not None and current > updated_at

    async def replace(
        self,
        *,
        org_id: str,
        source_type: str,
        source_id: str,
        acl_id: str,
        title: str,
        updated_at: datetime,
        chunks: list[str],
        embeddings: list[list[float]],
    ) -> tuple[str, int]:
        """Replaces every chunk of one source unless a newer version is already indexed."""
        rows = [
            (org_id, source_type, source_id, i, acl_id, title, text, updated_at, vector_literal(vec))
            for i, (text, vec) in enumerate(zip(chunks, embeddings, strict=True))
        ]
        async with self._pool().acquire() as con, con.transaction():
            await con.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                f"{org_id}\x1f{source_type}\x1f{source_id}",
            )
            current = await con.fetchval(
                "SELECT max(source_updated_at) FROM ai_chunks WHERE org_id = $1 AND source_type = $2 AND source_id = $3",
                org_id,
                source_type,
                source_id,
            )
            if current is not None and current > updated_at:
                return "stale", 0
            await con.execute(
                "DELETE FROM ai_chunks WHERE org_id = $1 AND source_type = $2 AND source_id = $3",
                org_id,
                source_type,
                source_id,
            )
            await con.executemany(
                """
                INSERT INTO ai_chunks (org_id, source_type, source_id, chunk_no, acl_id, title, content,
                                       source_updated_at, embedding)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
                """,
                rows,
            )
        return "indexed", len(rows)

    async def delete(self, org_id: str, source_type: str | None = None, source_id: str | None = None) -> int:
        if source_type is None or source_id is None:
            status = await self._pool().execute("DELETE FROM ai_chunks WHERE org_id = $1", org_id)
        else:
            status = await self._pool().execute(
                "DELETE FROM ai_chunks WHERE org_id = $1 AND source_type = $2 AND source_id = $3",
                org_id,
                source_type,
                source_id,
            )
        return int(status.split()[-1])

    async def search(self, org_id: str, query_vector: list[float], allowed_acl_ids: list[str], limit: int) -> list[Hit]:
        allowed = sorted(set(allowed_acl_ids))
        if not allowed:
            return []
        async with self._pool().acquire() as con, con.transaction():
            if self.iterative_scan:
                await con.execute("SET LOCAL hnsw.iterative_scan = strict_order")
            rows = await con.fetch(
                """
                SELECT source_type, source_id, chunk_no, acl_id, title, content, source_updated_at,
                       1 - (embedding <=> $1::vector) AS score
                FROM ai_chunks
                WHERE org_id = $2 AND acl_id = ANY($3::text[])
                ORDER BY embedding <=> $1::vector
                LIMIT $4
                """,
                vector_literal(query_vector),
                org_id,
                allowed,
                limit,
            )
        return [
            Hit(
                source_type=r["source_type"],
                source_id=r["source_id"],
                chunk=r["chunk_no"],
                acl_id=r["acl_id"],
                title=r["title"],
                text=r["content"],
                score=float(r["score"]),
                updated_at=r["source_updated_at"],
            )
            for r in rows
        ]
