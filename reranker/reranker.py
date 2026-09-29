"""
Lightweight CPU reranker sidecar — cross-encoder for KB search reranking.

Uses a multilingual cross-encoder (mmarco-mMiniLMv2-L-12-H-384-v1) to rerank
query-document pairs. Designed to run on CPU-only VMs (e.g. Azure D4s v3).

Backends (auto-detected):
  - ONNX Runtime: used inside Docker (model pre-exported at build time)
  - sentence-transformers: used for local development (auto-downloads model)

Endpoints:
  POST /rerank   — rerank documents by relevance to a query
  GET  /health   — healthcheck
"""

from __future__ import annotations

import logging
import math
import os
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger("reranker")


# ── Configuration ────────────────────────────────────────────────────
class Settings(BaseSettings):
    """Read once from the environment: RERANK_MODEL, PORT, MODEL_DIR, ORT_THREADS."""

    rerank_model: str = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
    port: int = 8000
    model_dir: str = "/app/model"
    # 0 lets ONNX Runtime pick the thread count itself.
    ort_threads: int = 0

    model_config = SettingsConfigDict(extra="ignore")


settings = Settings()

# ── Global model holders ────────────────────────────────────────────
_backend = "none"  # "onnx" or "sentence-transformers"
ort_session = None
tokenizer = None
cross_encoder = None


def _sigmoid(x: float) -> float:
    """Numerically-stable sigmoid of one logit."""
    if x >= 0:
        return 1 / (1 + math.exp(-x))
    e = math.exp(x)
    return e / (1 + e)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load the model at startup — ONNX if available, else sentence-transformers."""
    global ort_session, tokenizer, cross_encoder, _backend

    onnx_path = os.path.join(settings.model_dir, "model.onnx")
    t0 = time.time()

    if os.path.exists(onnx_path):
        # ── ONNX Runtime (production / Docker) ──────────────────
        import onnxruntime as ort
        from transformers import AutoTokenizer

        logger.info("Loading ONNX model from %s …", settings.model_dir)
        tokenizer = AutoTokenizer.from_pretrained(settings.model_dir)

        sess_opts = ort.SessionOptions()
        sess_opts.inter_op_num_threads = settings.ort_threads
        sess_opts.intra_op_num_threads = settings.ort_threads
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        ort_session = ort.InferenceSession(
            onnx_path, sess_opts, providers=["CPUExecutionProvider"]
        )
        _backend = "onnx"
        logger.info("Reranker ready (ONNX) in %.1fs", time.time() - t0)
    else:
        # ── sentence-transformers (local dev) ───────────────────
        logger.info(
            "ONNX model not found at %s — using sentence-transformers (local dev mode)",
            onnx_path,
        )
        try:
            from sentence_transformers import CrossEncoder

            cross_encoder = CrossEncoder(settings.rerank_model, device="cpu")
            _backend = "sentence-transformers"
            logger.info(
                "Reranker ready (sentence-transformers CPU) in %.1fs", time.time() - t0
            )
        except ImportError:
            logger.error(
                "Neither ONNX model nor sentence-transformers available.\n"
                "Install for local dev:  pip install sentence-transformers torch --extra-index-url https://download.pytorch.org/whl/cpu"
            )
            raise SystemExit(1)

    yield
    logger.info("Shutting down reranker")


app = FastAPI(title="BeeFlow Reranker", lifespan=lifespan)


# ── Request / Response schemas ──────────────────────────────────────


class RerankRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., max_length=10_000)
    documents: list[str] = Field(..., max_length=200)
    top_n: int | None = Field(None, ge=1)


class RerankResult(BaseModel):
    index: int
    relevance_score: float
    document: str | None = None


class RerankResponse(BaseModel):
    results: list[RerankResult]
    model: str = ""
    latency_ms: float = 0
    backend: str = ""


# ── Inference helpers ───────────────────────────────────────────────


def _infer_onnx(query: str, documents: list[str]) -> list[float]:
    """Score pairs with ONNX Runtime."""
    import numpy as np

    encoded = tokenizer(
        [query] * len(documents),
        documents,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="np",
    )
    feeds = {
        "input_ids": encoded["input_ids"].astype(np.int64),
        "attention_mask": encoded["attention_mask"].astype(np.int64),
    }
    if "token_type_ids" in encoded:
        feeds["token_type_ids"] = encoded["token_type_ids"].astype(np.int64)

    outputs = ort_session.run(None, feeds)
    logits = outputs[0]

    if logits.ndim == 2:
        raw = logits[:, 0] if logits.shape[1] == 1 else logits[:, 1]
    else:
        raw = logits

    return [_sigmoid(float(x)) for x in raw.tolist()]


def _infer_st(query: str, documents: list[str]) -> list[float]:
    """Score pairs with sentence-transformers CrossEncoder."""
    pairs = [(query, doc) for doc in documents]
    raw = cross_encoder.predict(pairs, show_progress_bar=False)
    if hasattr(raw, "tolist"):
        raw = raw.tolist()
    if not isinstance(raw, list):
        raw = [float(raw)]
    return [_sigmoid(float(x)) for x in raw]


def _rank(
    scores: list[float], documents: list[str], top_n: int | None
) -> list[RerankResult]:
    """Pair every document with its score, best first, cut to ``top_n``."""
    results = [
        RerankResult(index=i, relevance_score=round(score, 4), document=doc)
        for i, (score, doc) in enumerate(zip(scores, documents))
    ]
    results.sort(key=lambda r: r.relevance_score, reverse=True)
    if top_n is not None:
        results = results[:top_n]
    return results


# ── Endpoints ───────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": settings.rerank_model,
        "backend": _backend,
    }


@app.post("/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    """Score and rank documents by relevance to the query."""
    if not req.documents:
        return RerankResponse(results=[], model=settings.rerank_model, backend=_backend)

    t0 = time.time()

    if _backend == "onnx":
        scores = _infer_onnx(req.query, req.documents)
    else:
        scores = _infer_st(req.query, req.documents)

    results = _rank(scores, req.documents, req.top_n)

    elapsed_ms = (time.time() - t0) * 1000
    logger.info(
        "Reranked %d docs in %.0fms  (top=%.3f, bottom=%.3f, backend=%s)",
        len(req.documents),
        elapsed_ms,
        results[0].relevance_score if results else 0,
        results[-1].relevance_score if results else 0,
        _backend,
    )

    return RerankResponse(
        results=results,
        model=settings.rerank_model,
        latency_ms=round(elapsed_ms, 1),
        backend=_backend,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.port, workers=1)
