"""
Intel-optimized inference server — embeddings + reranking via OpenVINO.
Uses OpenVINO for CPU (with AVX-512 optimization on Intel CPUs) or Intel GPU.

Exposes OpenAI-compatible endpoints so the search-api client works unchanged.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s"
)
logger = logging.getLogger("inference")


# ── Configuration ────────────────────────────────────────────────────
class Settings(BaseSettings):
    """Read once from the environment: EMBED_MODEL, RERANK_MODEL,
    EMBED_DIMENSIONS, DEVICE, PORT and SERVICES_API_KEY."""

    embed_model: str = "Qwen/Qwen3-Embedding-0.6B"
    rerank_model: str = "BAAI/bge-reranker-v2-m3"
    # Embedding output is truncated to this many dimensions.
    embed_dimensions: int = 1024
    # auto, GPU, CPU
    device: str = "auto"
    port: int = 8001
    # Empty means the endpoints are open.
    services_api_key: str = ""

    model_config = SettingsConfigDict(extra="ignore")


settings = Settings()

# ── Global model holders ────────────────────────────────────────────
embed_model = None
embed_tokenizer = None
rerank_model = None
rerank_tokenizer = None
actual_device = "unknown"
USE_OPENVINO = False


def detect_device() -> str:
    """Detect the best available device: CUDA GPU > Apple Silicon MPS > Intel OpenVINO GPU > CPU."""
    if settings.device != "auto":
        return settings.device
    # Check CUDA GPU first
    try:
        import torch

        if torch.cuda.is_available():
            logger.info("CUDA GPU detected: %s", torch.cuda.get_device_name(0))
            return "cuda"
        # Check Apple Silicon MPS
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            logger.info("Apple Silicon MPS detected")
            return "mps"
    except ImportError:
        pass
    # Check Intel OpenVINO
    try:
        import openvino as ov

        core = ov.Core()
        devices = core.available_devices
        logger.info("OpenVINO available devices: %s", devices)
        if "GPU" in devices:
            return "GPU"
        return "CPU"
    except ImportError:
        return "CPU"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:  # noqa: PLR0915
    """Load models at startup using the best available backend."""
    global embed_model, embed_tokenizer, rerank_model, rerank_tokenizer
    global actual_device, USE_OPENVINO

    actual_device = detect_device()
    logger.info("Selected device: %s", actual_device)

    USE_CUDA = actual_device == "cuda"
    USE_MPS = actual_device == "mps"

    # Try OpenVINO for Intel hardware (skip if CUDA or MPS — those have native paths)
    if not USE_CUDA and not USE_MPS:
        try:
            from optimum.intel import (
                OVModelForFeatureExtraction,
                OVModelForSequenceClassification,
            )
            from transformers import AutoTokenizer

            USE_OPENVINO = True
            logger.info("OpenVINO optimum-intel available — using optimized backend")
        except ImportError:
            USE_OPENVINO = False
            logger.warning(
                "optimum-intel not available — falling back to sentence-transformers"
            )

    # ── Load embedding model ─────────────────────────────────────
    logger.info(
        "Loading embedding model: %s (device=%s, cuda=%s, openvino=%s)",
        settings.embed_model,
        actual_device,
        USE_CUDA,
        USE_OPENVINO,
    )
    t0 = time.time()

    if USE_CUDA:
        from sentence_transformers import SentenceTransformer

        embed_model = SentenceTransformer(settings.embed_model, device="cuda")
        embed_model.half()  # FP16 — halves VRAM, faster inference
        logger.info(
            "Embedding model loaded (CUDA GPU, FP16) in %.1fs", time.time() - t0
        )
    elif USE_MPS:
        from sentence_transformers import SentenceTransformer

        # FP32 on MPS — fp16 triggers CPU fallback for unsupported ops, slower than fp32
        embed_model = SentenceTransformer(settings.embed_model, device="mps")
        logger.info(
            "Embedding model loaded (Apple Silicon MPS, FP32) in %.1fs",
            time.time() - t0,
        )
    elif USE_OPENVINO:
        from optimum.intel import OVModelForFeatureExtraction
        from transformers import AutoTokenizer

        embed_tokenizer = AutoTokenizer.from_pretrained(settings.embed_model)
        embed_model = OVModelForFeatureExtraction.from_pretrained(
            settings.embed_model,
            export=True,
            device=actual_device,
        )
        logger.info(
            "Embedding model loaded (OpenVINO %s) in %.1fs",
            actual_device,
            time.time() - t0,
        )
    else:
        from sentence_transformers import SentenceTransformer

        embed_model = SentenceTransformer(settings.embed_model, device="cpu")
        logger.info("Embedding model loaded (PyTorch CPU) in %.1fs", time.time() - t0)

    # ── Load reranker model ──────────────────────────────────────
    logger.info(
        "Loading reranker model: %s (device=%s, cuda=%s, openvino=%s)",
        settings.rerank_model,
        actual_device,
        USE_CUDA,
        USE_OPENVINO,
    )
    t0 = time.time()

    if USE_CUDA:
        from sentence_transformers import CrossEncoder

        rerank_model = CrossEncoder(settings.rerank_model, device="cuda")
        rerank_model.model.half()  # FP16 — faster reranking
        logger.info("Reranker model loaded (CUDA GPU, FP16) in %.1fs", time.time() - t0)
    elif USE_MPS:
        from sentence_transformers import CrossEncoder

        rerank_model = CrossEncoder(settings.rerank_model, device="mps")
        logger.info(
            "Reranker model loaded (Apple Silicon MPS, FP32) in %.1fs", time.time() - t0
        )
    elif USE_OPENVINO:
        from optimum.intel import OVModelForSequenceClassification
        from transformers import AutoTokenizer

        rerank_tokenizer = AutoTokenizer.from_pretrained(settings.rerank_model)
        rerank_model = OVModelForSequenceClassification.from_pretrained(
            settings.rerank_model,
            export=True,
            device=actual_device,
        )
        logger.info(
            "Reranker model loaded (OpenVINO %s) in %.1fs",
            actual_device,
            time.time() - t0,
        )
    else:
        from sentence_transformers import CrossEncoder

        rerank_model = CrossEncoder(settings.rerank_model, device="cpu")
        logger.info("Reranker model loaded (PyTorch CPU) in %.1fs", time.time() - t0)

    yield
    logger.info("Shutting down inference server")


app = FastAPI(title="Intel Inference Server", lifespan=lifespan)


# ── API Key authentication middleware ────────────────────────────────
class APIKeyMiddleware(BaseHTTPMiddleware):
    """Require X-API-Key on every request except /health once a key is configured."""

    def __init__(self, app, api_key: str = "") -> None:
        super().__init__(app)
        self._api_key = api_key

    async def dispatch(self, request, call_next):
        if not self._api_key:
            return await call_next(request)
        if request.url.path.startswith("/health"):
            return await call_next(request)
        key = request.headers.get("X-API-Key", "")
        if key != self._api_key:
            return JSONResponse(
                {"error": "Invalid or missing API key"}, status_code=401
            )
        return await call_next(request)


if settings.services_api_key:
    app.add_middleware(APIKeyMiddleware, api_key=settings.services_api_key)
    logger.info("API key authentication enabled")


# ── OpenVINO helper functions ───────────────────────────────────────


def ov_embed(texts: list[str]) -> np.ndarray:
    """Compute embeddings using OpenVINO model with mean pooling."""
    inputs = embed_tokenizer(
        texts, padding=True, truncation=True, max_length=512, return_tensors="pt"
    )
    outputs = embed_model(**inputs)

    # Mean pooling
    token_embeddings = (
        outputs.last_hidden_state.numpy()
        if hasattr(outputs.last_hidden_state, "numpy")
        else np.array(outputs.last_hidden_state)
    )
    attention_mask = (
        inputs["attention_mask"].numpy()
        if hasattr(inputs["attention_mask"], "numpy")
        else np.array(inputs["attention_mask"])
    )

    mask_expanded = np.expand_dims(attention_mask, -1).astype(np.float32)
    sum_embeddings = np.sum(token_embeddings * mask_expanded, axis=1)
    sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)
    embeddings = sum_embeddings / sum_mask

    # L2 normalize
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-9, a_max=None)
    embeddings = embeddings / norms

    return embeddings


def ov_rerank(query: str, documents: list[str]) -> list[float]:
    """Compute reranking scores using OpenVINO model."""
    pairs_a = [query] * len(documents)
    inputs = rerank_tokenizer(
        pairs_a,
        documents,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="pt",
    )
    outputs = rerank_model(**inputs)
    logits = outputs.logits
    if hasattr(logits, "numpy"):
        logits = logits.numpy()
    else:
        logits = np.array(logits)
    scores = logits.squeeze(-1)
    return scores.tolist() if hasattr(scores, "tolist") else [float(scores)]


# ── Request / Response schemas (OpenAI-compatible) ──────────────────


class EmbedRequest(BaseModel):
    model: str = settings.embed_model
    input: list[str] | str = []


class EmbedResponse(BaseModel):
    object: str = "list"
    data: list[dict] = []
    model: str = ""
    usage: dict = {}


class RerankRequest(BaseModel):
    model: str = settings.rerank_model
    query: str
    documents: list[str]
    top_n: int | None = None


class RerankResponse(BaseModel):
    results: list[dict] = []


# ── Endpoints ───────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": actual_device,
        "backend": "openvino" if USE_OPENVINO else "pytorch",
        "embed_model": settings.embed_model,
        "rerank_model": settings.rerank_model,
    }


@app.post("/v1/embeddings", response_model=EmbedResponse)
async def embeddings(req: EmbedRequest):
    """OpenAI-compatible embeddings endpoint."""
    texts = req.input if isinstance(req.input, list) else [req.input]

    logger.info(
        "Embedding %d texts (device=%s, ov=%s)", len(texts), actual_device, USE_OPENVINO
    )
    t0 = time.time()

    if USE_OPENVINO:
        vectors = ov_embed(texts)
        # Truncate to configured dimensions
        if vectors.shape[1] > settings.embed_dimensions:
            vectors = vectors[:, : settings.embed_dimensions]
    else:
        vectors = embed_model.encode(
            texts, normalize_embeddings=True, show_progress_bar=False
        )
        # Truncate to configured dimensions if model outputs more
        if hasattr(vectors, "shape") and vectors.shape[1] > settings.embed_dimensions:
            vectors = vectors[:, : settings.embed_dimensions]
            # Re-normalize after truncation
            norms = np.linalg.norm(vectors, axis=1, keepdims=True)
            norms = np.clip(norms, a_min=1e-9, a_max=None)
            vectors = vectors / norms

    elapsed = time.time() - t0
    logger.info("Embedded %d texts in %.2fs", len(texts), elapsed)

    data = [
        {
            "object": "embedding",
            "index": i,
            "embedding": vec.tolist() if hasattr(vec, "tolist") else list(vec),
        }
        for i, vec in enumerate(vectors)
    ]

    return EmbedResponse(
        data=data,
        model=req.model,
        usage={
            "prompt_tokens": sum(len(t.split()) for t in texts),
            "total_tokens": sum(len(t.split()) for t in texts),
        },
    )


@app.post("/v1/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    """Reranking endpoint."""
    if not req.documents:
        return RerankResponse(results=[])

    logger.info(
        "Reranking %d documents (device=%s, ov=%s)",
        len(req.documents),
        actual_device,
        USE_OPENVINO,
    )
    t0 = time.time()

    if USE_OPENVINO:
        scores = ov_rerank(req.query, req.documents)
    else:
        pairs = [(req.query, doc) for doc in req.documents]
        scores = rerank_model.predict(pairs, show_progress_bar=False)
        if hasattr(scores, "tolist"):
            scores = scores.tolist()
        if not isinstance(scores, list):
            scores = [float(scores)]

    elapsed = time.time() - t0
    logger.info("Reranked %d documents in %.2fs", len(req.documents), elapsed)

    results = [
        {"index": i, "relevance_score": float(score)} for i, score in enumerate(scores)
    ]
    results.sort(key=lambda x: x["relevance_score"], reverse=True)

    if req.top_n is not None:
        results = results[: req.top_n]

    return RerankResponse(results=results)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.port, workers=1)
