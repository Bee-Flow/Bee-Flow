"""
PostgreSQL connection pool and schema bootstrap.
"""

from __future__ import annotations

import asyncpg

from app.observability.logging import logger

SCHEMA_SQL = """
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- KB chunks table
CREATE TABLE IF NOT EXISTS kb_chunks (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    document_id   TEXT NOT NULL,
    chunk_id      INT NOT NULL,
    lang          TEXT,
    title         TEXT,
    content       TEXT NOT NULL,
    tsv           TSVECTOR,
    embedding     VECTOR(1024),
    source_uri    TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_kb_chunks_tsv
    ON kb_chunks USING GIN (tsv);

-- Vector similarity index (HNSW for best general performance)
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding
    ON kb_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- Scoping indexes
CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb
    ON kb_chunks (tenant_id, knowledge_base_id);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb_doc
    ON kb_chunks (tenant_id, knowledge_base_id, document_id);
"""


async def bootstrap_schema(pool: asyncpg.Pool) -> None:
    """Create tables and indexes if they don't exist."""
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)
    logger.info("Database schema bootstrapped")
