"""
HTTP client for vLLM inference endpoints — embeddings, reranking, text cleanup.
"""

from __future__ import annotations

from typing import Optional

import httpx

from app.config import settings
from app.observability.logging import logger, latency


def _service_headers() -> dict[str, str]:
    """The inference sidecar requires the shared key once it is configured."""
    return {"X-API-Key": settings.services_api_key} if settings.services_api_key else {}


class InferenceClient:
    """Async client for communication with vLLM-served models."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http

    # ── Embeddings (bge-m3) ──────────────────────────────────────────

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Compute embeddings for a batch of texts via the embedding endpoint."""
        if not settings.inference_enabled:
            logger.warning("Inference disabled — returning zero vectors")
            return [[0.0] * settings.embed_dimensions for _ in texts]

        logger.info(
            "[LOCAL Embed] model=%s, texts=%d, dims=%d, url=%s",
            settings.embed_model,
            len(texts),
            settings.embed_dimensions,
            settings.embed_api_url,
        )

        url = f"{settings.embed_api_url}/embeddings"
        payload = {
            "model": settings.embed_model,
            "input": texts,
        }
        with latency.track("embed_inference"):
            resp = await self._http.post(
                url, json=payload, headers=_service_headers(), timeout=30.0
            )
            resp.raise_for_status()

        data = resp.json()
        # OpenAI-compatible response: data[].embedding
        embeddings = [
            item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])
        ]
        return embeddings

    async def embed_single(self, text: str) -> list[float]:
        """Embed a single text string."""
        results = await self.embed([text])
        return results[0]

    # ── Reranking (bge-reranker-large) ───────────────────────────────

    async def rerank(
        self, query: str, documents: list[str], top_n: Optional[int] = None
    ) -> list[dict]:
        """
        Rerank documents against query. Returns list of
        {"index": int, "relevance_score": float} sorted by score desc.
        """
        if not settings.inference_enabled:
            logger.warning("Inference disabled — returning passthrough scores")
            return [
                {"index": i, "relevance_score": 1.0 / (i + 1)}
                for i in range(len(documents))
            ]

        logger.info(
            "[LOCAL Rerank] model=%s, query_len=%d, docs=%d, url=%s",
            settings.rerank_model,
            len(query),
            len(documents),
            settings.rerank_api_url,
        )

        # Try the /rerank endpoint first (vLLM >= 0.6 supports this)
        url = f"{settings.rerank_api_url}/rerank"
        payload = {
            "model": settings.rerank_model,
            "query": query,
            "documents": documents,
        }
        if top_n is not None:
            payload["top_n"] = top_n

        with latency.track("rerank_inference"):
            try:
                resp = await self._http.post(
                    url, json=payload, headers=_service_headers(), timeout=60.0
                )
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results", data.get("data", []))
                return sorted(
                    results, key=lambda x: x.get("relevance_score", 0), reverse=True
                )
            except (
                httpx.HTTPStatusError,
                httpx.ConnectError,
                httpx.ReadTimeout,
                httpx.TimeoutException,
            ) as e:
                logger.warning(
                    "Rerank endpoint failed (%s), using score-passthrough",
                    type(e).__name__,
                )
                return [
                    {"index": i, "relevance_score": 1.0 / (i + 1)}
                    for i in range(len(documents))
                ]

    # ── Text cleanup / summarization (Qwen2.5-7B) ───────────────────

    async def cleanup_markdown(  # noqa: PLR0913
        self,
        markdown: str,
        url: str = "",
        title: str = "",
        lang: str = "unknown",
        max_tokens: int = 1200,
        include_citations: bool = True,
        detail_level: str = "detailed",
    ) -> str:
        """
        Use the LLM to convert extracted content into clean agent-readable markdown.
        detail_level: 'basic' (compact summary), 'detailed' (structured), 'highly_detailed' (max info).
        If inference is disabled, returns the input truncated to max_tokens.
        """
        if not settings.inference_enabled:
            logger.info("Inference disabled — returning raw markdown (truncated)")
            return markdown[: max_tokens * 4]  # rough char approximation

        system_prompt = "You convert extracted webpage content into clean structured markdown for AI agents."

        citations_instruction = ""
        if include_citations:
            citations_instruction = '- If citations are requested, add "## Citations" with bullet URLs only (no extra commentary).'

        # Adjust prompt and output limits based on detail level
        if detail_level == "basic":
            effective_tokens = min(max_tokens, 300)
            detail_instructions = f"""Output requirements:
- Output valid markdown.
- Start with: "# {title}" (if title known) else "# Web Result".
- Write a compact summary in 3-5 bullet points. Be extremely concise.
- Keep ONLY the most important facts: key numbers, dates, names, conclusions.
- Total output MUST stay under {effective_tokens} tokens.
- Do NOT include navigation, cookie banners, or unrelated content.
{citations_instruction}"""

        elif detail_level == "highly_detailed":
            effective_tokens = max(max_tokens, 2000)
            detail_instructions = f"""Output requirements:
- Output valid markdown.
- Start with: "# {title}" (if title known) else "# Web Result".
- Then "## Summary" (5-8 bullet overview).
- Then "## Full Details" — preserve as much factual content as possible.
- Use subsections with "###" for different topics.
- Keep ALL important numbers, dates, names, quotes, statistics, lists, and technical details.
- Preserve original data tables and lists where present.
- Include context and explanations — do not oversimplify.
- Do NOT include navigation, cookie banners, or unrelated content.
- Keep total output under {effective_tokens} tokens.
{citations_instruction}"""

        else:  # "detailed" (default — existing behavior)
            effective_tokens = max_tokens
            detail_instructions = f"""Output requirements:
- Output valid markdown.
- Start with: "# {title}" (if title known) else "# Web Result".
- Then "## Key Points" (3–7 bullets).
- Then "## Details" (short sections with headings; keep facts, remove fluff).
- Keep important numbers, dates, names.
- If the text includes multiple topics, separate with "###".
- Do NOT include any navigation, cookie banners, subscribe prompts, or unrelated links.
- Keep total output under {effective_tokens} tokens.
{citations_instruction}"""

        user_prompt = f"""Input: extracted markdown from a webpage.

{detail_instructions}

Now convert the following content:
---
{markdown}
---
Known URL: {url}
Known title: {title}
Language: {lang}"""

        api_url = f"{settings.cleanup_api_url}/chat/completions"
        payload = {
            "model": settings.cleanup_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": effective_tokens,
            "temperature": 0.1,
        }

        with latency.track("cleanup_inference"):
            try:
                resp = await self._http.post(
                    api_url, json=payload, headers=_service_headers(), timeout=60.0
                )
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            except (httpx.HTTPStatusError, httpx.ConnectError, OSError, KeyError) as e:
                logger.debug(
                    "Cleanup inference unavailable: %s — returning raw markdown",
                    type(e).__name__,
                )
                return markdown[: effective_tokens * 4]


# ── Azure-native inference client ─────────────────────────────────

import math


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class AzureInferenceClient:
    """
    Inference client that uses Azure OpenAI for embeddings
    instead of local vLLM endpoints. Drop-in replacement for InferenceClient
    for the embed() and rerank() methods.
    """

    def __init__(
        self,
        http: httpx.AsyncClient,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        self._http = http
        self._endpoint = (endpoint or settings.azure_openai_endpoint).rstrip("/")
        self._api_key = api_key or settings.azure_openai_key
        self._model = model or settings.azure_openai_embed_model
        self._dimensions = settings.azure_openai_embed_dimensions

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Compute embeddings via Azure OpenAI embeddings API."""
        if not self._endpoint or not self._api_key:
            raise RuntimeError("Azure OpenAI not configured (endpoint/key missing)")

        logger.info(
            "[AZURE Embed] model=%s, texts=%d, dims=%d, endpoint=%s",
            self._model,
            len(texts),
            self._dimensions,
            self._endpoint,
        )

        url = (
            f"{self._endpoint}/openai/deployments/{self._model}"
            f"/embeddings?api-version=2024-06-01"
        )
        payload = {"input": texts}
        headers = {
            "api-key": self._api_key,
            "Content-Type": "application/json",
        }

        with latency.track("azure_embed_inference"):
            resp = await self._http.post(
                url, json=payload, headers=headers, timeout=30.0
            )
            resp.raise_for_status()

        data = resp.json()
        embeddings = [
            item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])
        ]
        return embeddings

    async def embed_single(self, text: str) -> list[float]:
        """Embed a single text string via Azure OpenAI."""
        results = await self.embed([text])
        return results[0]

    async def rerank(
        self, query: str, documents: list[str], top_n: Optional[int] = None
    ) -> list[dict]:
        """
        Rerank using embedding-based cosine similarity.
        Azure OpenAI doesn't have a native rerank endpoint, so we embed
        query + documents and compute cosine similarity.
        """
        all_texts = [query] + documents
        logger.info(
            "[AZURE Rerank] method=cosine_similarity, model=%s, query_len=%d, docs=%d",
            self._model,
            len(query),
            len(documents),
        )
        embeddings = await self.embed(all_texts)
        query_emb = embeddings[0]

        results = []
        for i, doc_emb in enumerate(embeddings[1:]):
            score = _cosine_similarity(query_emb, doc_emb)
            results.append({"index": i, "relevance_score": score})

        results.sort(key=lambda x: x["relevance_score"], reverse=True)
        return results[:top_n] if top_n else results


def get_inference_client(
    http: httpx.AsyncClient,
    use_azure: bool = False,
    azure_endpoint: Optional[str] = None,
    azure_key: Optional[str] = None,
    azure_model: Optional[str] = None,
):
    """Return the appropriate inference client based on the use_azure flag."""
    if use_azure:
        logger.info("[Pipeline] Using AZURE inference client (Azure OpenAI)")
        return AzureInferenceClient(
            http, endpoint=azure_endpoint, api_key=azure_key, model=azure_model
        )
    logger.info("[Pipeline] Using LOCAL inference client (vLLM)")
    return InferenceClient(http)
