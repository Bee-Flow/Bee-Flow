"""
SQL queries for KB hybrid search and chunk insertion.
Multi-language support: Dutch + English stemming for FTS.
"""

from __future__ import annotations

# ── Vector similarity search ─────────────────────────────────────────

VECTOR_SEARCH_SQL = """
SELECT id, title, content, source_uri,
       1 - (embedding <=> $1::vector) AS vec_score
FROM kb_chunks
WHERE tenant_id = $2
  AND knowledge_base_id = ANY($3::text[])
ORDER BY embedding <=> $1::vector
LIMIT $4;
"""

# ── Full-text search (multi-language: Dutch + English + simple) ──────
# Tries Dutch stemming first, then English, then simple (unstemmed).
# Uses OR to match any language variant, ranked by best match.

FTS_SEARCH_SQL = """
SELECT id, title, content, source_uri,
       GREATEST(
           ts_rank_cd(tsv, websearch_to_tsquery('dutch', $1)),
           ts_rank_cd(tsv, websearch_to_tsquery('english', $1)),
           ts_rank_cd(tsv, websearch_to_tsquery('simple', $1))
       ) AS fts_score
FROM kb_chunks
WHERE tenant_id = $2
  AND knowledge_base_id = ANY($3::text[])
  AND (
      tsv @@ websearch_to_tsquery('dutch', $1)
      OR tsv @@ websearch_to_tsquery('english', $1)
      OR tsv @@ websearch_to_tsquery('simple', $1)
  )
ORDER BY fts_score DESC
LIMIT $4;
"""

# ── Insert chunk (multi-language tsvector) ───────────────────────────
# Stores Dutch-stemmed tokens at weight A, English at B, and simple at C
# so all three language variants are searchable.

INSERT_CHUNK_SQL = """
INSERT INTO kb_chunks (
    tenant_id, knowledge_base_id, document_id,
    chunk_id, lang, title, content, tsv, embedding, source_uri
)
VALUES (
    $1, $2, $3,
    $4, $5, $6, $7,
    setweight(to_tsvector('dutch', $7), 'A') ||
    setweight(to_tsvector('english', $7), 'B') ||
    setweight(to_tsvector('simple', $7), 'C'),
    $8::vector,
    $9
)
RETURNING id;
"""

# ── Delete document chunks (for re-ingestion) ───────────────────────

DELETE_DOCUMENT_CHUNKS_SQL = """
DELETE FROM kb_chunks
WHERE tenant_id = $1
  AND knowledge_base_id = $2
  AND document_id = $3;
"""
