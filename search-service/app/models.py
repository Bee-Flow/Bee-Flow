"""
Pydantic request / response schemas — matches spec §2.1 exactly.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


# ── Enums ────────────────────────────────────────────────────────────


class SearchMode(str, Enum):
    auto = "auto"
    web = "web"
    web_fast = "web_fast"
    kb = "kb"


class DetailLevel(str, Enum):
    basic = "basic"
    detailed = "detailed"
    highly_detailed = "highly_detailed"


class SourceType(str, Enum):
    web = "web"
    kb = "kb"


# ── Request models ───────────────────────────────────────────────────
#
# Every REQUEST model rejects unknown fields (extra="forbid"). Without it
# Pydantic v2 silently drops what this build doesn't know, so a caller newer
# than the service gets its request quietly mangled instead of a loud 422
# (U9: an old sidecar must refuse what it cannot honour). Before sending a
# field a given build may not know, the server reads `version` from
# GET /health (see app/main.py SERVICE_VERSION). Response models stay
# tolerant on purpose — the Node side normalises those with defaults.


class KBScope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    knowledge_base_ids: list[str] = Field(default_factory=list)


class WebParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_results: int = Field(default=5, ge=1, le=20)
    fetch_top_n: int = Field(default=3, ge=1, le=10)
    allow_js_fallback: bool = False


class KBParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    top_k_vector: int = Field(default=40, ge=1, le=200)
    top_k_fts: int = Field(default=40, ge=1, le=200)
    top_k_final: int = Field(default=8, ge=1, le=50)
    use_reranker: bool = True


class ResponseParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_tokens_markdown: int = Field(default=1200, ge=100, le=8000)
    include_citations: bool = True
    include_snippets: bool = True
    detail_level: DetailLevel = DetailLevel.detailed


class SearchRequest(BaseModel):
    # Wire-parity: server/integrations/agentSearchTools.js:134-139 sends
    # {query, mode, web:{max_results, fetch_top_n},
    #  response:{include_citations, max_tokens_markdown, detail_level}}.
    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1, max_length=2000)
    mode: SearchMode = SearchMode.auto
    kb_scope: Optional[KBScope] = None
    web: WebParams = Field(default_factory=WebParams)
    kb: KBParams = Field(default_factory=KBParams)
    response: ResponseParams = Field(default_factory=ResponseParams)


# ── Response models ──────────────────────────────────────────────────


class Citation(BaseModel):
    url: Optional[str] = None
    title: Optional[str] = None


class ResultMetadata(BaseModel):
    lang: Optional[str] = None
    fetched_at: Optional[datetime] = None
    cache_hit: bool = False


class SearchResult(BaseModel):
    source_type: SourceType
    title: Optional[str] = None
    url: Optional[str] = None
    score: float = 0.0
    markdown: str = ""
    citations: list[Citation] = Field(default_factory=list)
    metadata: ResultMetadata = Field(default_factory=ResultMetadata)


class SearchResponse(BaseModel):
    query: str
    mode_used: SearchMode
    results: list[SearchResult] = Field(default_factory=list)


# ── Ingest models ────────────────────────────────────────────────────


class IngestRequest(BaseModel):
    # Wire-parity: server/core/kb/kbIngestionHelpers.js:578-587 sends
    # {tenant_id, knowledge_base_id, document_id, content, title, source_uri,
    #  lang[, use_azure, azure_endpoint, azure_key, azure_model]};
    # server/routes/templates.js sends a subset of the same fields.
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    knowledge_base_id: str
    document_id: str
    title: Optional[str] = None
    source_uri: Optional[str] = None
    lang: Optional[str] = None
    # Text content (alternative to file upload)
    content: Optional[str] = None
    # Use Azure-native pipeline (Azure OpenAI embeddings instead of local vLLM)
    use_azure: bool = False
    # Azure credentials (passed from server, overrides env vars)
    azure_endpoint: Optional[str] = None
    azure_key: Optional[str] = None
    azure_model: Optional[str] = None


class IngestResponse(BaseModel):
    document_id: str
    chunks_created: int
    status: str = "ok"


# ── Server-proxy models (POST /tools/kb-search) ──────────────────────
# Live here (not in the router) so the request contract is importable —
# and therefore testable — without FastAPI or the router's redis/asyncpg
# dependency chain.


class SimpleSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    kb_ids: list[str]
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=50)
    rerank: bool = True
    use_azure: bool = False  # Use Azure OpenAI for query embedding + reranking
    # Azure credentials (passed from server, overrides env vars)
    azure_endpoint: Optional[str] = None
    azure_key: Optional[str] = None
    azure_model: Optional[str] = None
    # Declared-and-ignored: server/integrations/kbSearchTools.js:253-260 always
    # includes this key (line 259) — even as null — carrying embed/rerank
    # routing hints this endpoint does not use (it routes via use_azure +
    # azure_* above). Without the declaration, extra="forbid" would 422 every
    # agent KB search that arrives through the remote provider.
    inference_routing: Optional[dict] = None


class SimpleChunk(BaseModel):
    content: str
    title: Optional[str] = None
    source_uri: Optional[str] = None
    score: float = 0.0


class SimpleSearchResponse(BaseModel):
    query: str
    chunks: list[SimpleChunk] = Field(default_factory=list)
    total: int = 0


# ── Inference API models (POST /embed, POST /rerank) ─────────────────
# No Node caller today (the server talks to the reranker sidecar and to
# OpenAI-compatible providers directly), so forbid is parity-safe here.


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input: list[str] = Field(..., min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimensions: int
    cached: int = 0


class RerankRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1)
    documents: list[str] = Field(..., min_length=1, max_length=100)
    top_n: int | None = None


class RerankResult(BaseModel):
    index: int
    relevance_score: float


class RerankResponse(BaseModel):
    results: list[RerankResult]
    model: str
