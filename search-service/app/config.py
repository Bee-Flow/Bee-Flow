"""
Application configuration — loaded from environment variables.
"""

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All configuration for the search service, loaded from env vars."""

    # ── General ──────────────────────────────────────────────────────
    app_name: str = "agent-search"
    # Shared with the Node server and the inference sidecar. The compose files
    # hand it over as SERVICES_API_KEY, without the SEARCH_ prefix every other
    # field carries, so both spellings are accepted.
    services_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("SERVICES_API_KEY", "SEARCH_SERVICES_API_KEY"),
    )
    debug: bool = False

    # ── Server ───────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000

    # ── Database (PostgreSQL with pgvector) ──────────────────────────
    database_url: str = "postgresql://search:search@localhost:5432/search_kb"
    db_pool_min: int = 2
    db_pool_max: int = 20

    # ── Redis ────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── Serper.dev (Google Search API) ───────────────────────────
    serper_api_key: str = ""
    serper_api_url: str = "https://google.serper.dev/search"
    serper_timeout: float = 5.0  # seconds
    serper_country: str = ""  # empty = auto (gl param)
    serper_lang: str = ""  # empty = auto (hl param)

    # ── Inference endpoints (vLLM) ───────────────────────────────────
    inference_enabled: bool = True
    embed_api_url: str = "http://localhost:8001/v1"
    embed_model: str = "Qwen/Qwen3-Embedding-4B"
    embed_dimensions: int = 1024

    rerank_api_url: str = "http://localhost:8002/v1"
    rerank_model: str = "BAAI/bge-reranker-v2-m3"

    cleanup_api_url: str = "http://localhost:8003/v1"
    cleanup_model: str = "Qwen/Qwen3-4B"

    # ── Ingest limits ──
    ingest_max_upload_bytes: int = 50 * 1024 * 1024  # 50 MB

    # ── Web fetch limits ─────────────────────────────────────────────
    web_max_concurrent_fetches: int = 3
    web_connect_timeout: float = 1.0  # seconds (fail fast on slow sites)
    web_read_timeout: float = 1.5  # seconds
    web_max_redirects: int = 5
    web_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
    web_raw_content_cap_bytes: int = 200 * 1024  # 200 KB
    web_cleanup_token_cap: int = 3000

    # ── httpx connection pool ────────────────────────────────────────
    httpx_max_connections: int = 100
    httpx_max_keepalive: int = 20

    # ── Cache TTLs (seconds) ─────────────────────────────────────────
    cache_ttl_searx: int = 3600  # 1 hour — web search results (Serper.dev)
    cache_ttl_page: int = 21600  # 6 hours
    cache_ttl_clean: int = 172800  # 48 hours
    cache_ttl_kb_query: int = 120  # 2 minutes
    cache_ttl_embedding: int = 86400  # 24 hours

    # ── KB defaults ──────────────────────────────────────────────────
    kb_default_top_k_vector: int = 20
    kb_default_top_k_fts: int = 20
    kb_default_top_k_final: int = 5

    # ── Chunking ─────────────────────────────────────────────────────
    chunk_size_tokens: int = 800
    chunk_overlap_tokens: int = 150

    # ── Auto-mode ────────────────────────────────────────────────────
    auto_kb_score_threshold: float = 0.62

    # ── KB quality ───────────────────────────────────────────────────
    kb_min_score_threshold: float = 0.40  # discard results below this score

    # ── Azure OpenAI (for Azure-native pipeline) ─────────────────────
    azure_openai_endpoint: str = ""
    azure_openai_key: str = ""
    azure_openai_embed_model: str = "text-embedding-3-small"
    azure_openai_embed_dimensions: int = 1536

    # ── Observability ────────────────────────────────────────────────
    log_level: str = "INFO"

    model_config = {"env_prefix": "SEARCH_", "env_file": ".env", "extra": "ignore"}


# Singleton
settings = Settings()
