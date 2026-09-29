"""
Standalone PII Detection Service — betterdataai/PII_DETECTION_MODEL
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pii")

# API-contract version — the single constant behind both the OpenAPI version
# and the `version` field on GET /health. Bump the MINOR on any
# request-contract change (a new accepted field, stricter validation): the
# server probes /health and only sends fields this build declares it knows.
# Older builds return just {status, model_ready} — the absent `version`
# itself means "pre-1.1 contract" (U9).
# 1.1.0 — /pii rejects unknown request fields (extra="forbid") and accepts
#         `enabled_regions` for wire-parity with the guard-service.
SERVICE_VERSION = "1.1.0"


def _check_api_key(x_api_key: str | None) -> None:
    """Raise 401 if SERVICES_API_KEY is configured and the header doesn't match."""
    if settings.services_api_key and x_api_key != settings.services_api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.service import get_pii_service

    svc = get_pii_service()
    svc.load(settings.pii_model)
    yield


app = FastAPI(
    title="Bee Flow — PII Detection Service",
    version=SERVICE_VERSION,
    lifespan=lifespan,
)


class PiiRequest(BaseModel):
    # Reject unknown fields: without extra="forbid", Pydantic v2 silently
    # drops what this build doesn't know, so a Node server newer than this
    # service would have e.g. a narrowing filter quietly ignored instead of
    # getting a loud 422 (U9). Wire-parity today:
    # server/core/privacy/piiDetection/guardClient.js:62-66 sends exactly
    # {text, confidence_threshold, enabled_categories}.
    model_config = ConfigDict(extra="forbid")

    # Same hard ceiling as guard-service (pii_hard_max_chars); a larger body is
    # a 422, not a model run that never returns.
    text: str = Field(
        ..., max_length=4_000_000, description="Text to scan for PII entities"
    )
    confidence_threshold: float = Field(0.7, ge=0.0, le=1.0)
    enabled_categories: list[str] | None = Field(
        None,
        description="Restrict to these category keys (null = all)",
    )
    # Accepted-and-ignored, for wire-parity with the guard-service (the same
    # PII_SERVICE_URL can point at either): guard's /pii knows this field, so
    # the day the server starts sending it, a forbid'ing build here must not
    # 422. This detector has no region-scoped tier to narrow; ignoring the
    # filter can only ever detect MORE than asked, never redact less.
    enabled_regions: list[str] | None = Field(
        None,
        description="Region filter (ISO 3166-1 alpha-2); accepted for "
        "guard-service wire-parity, not used by this detector",
    )


class PiiEntity(BaseModel):
    text: str
    category: str
    label: str
    confidence: float
    offset: int
    length: int


class PiiResponse(BaseModel):
    hasPii: bool
    entities: list[PiiEntity]


@app.get("/health")
async def health():
    # `version` is the API-contract version (SERVICE_VERSION): the server
    # reads it here before sending request fields an older build would reject.
    from app.service import get_pii_service

    return {
        "status": "ok",
        "model_ready": get_pii_service().ready,
        "version": SERVICE_VERSION,
    }


@app.post("/pii", response_model=PiiResponse)
async def detect_pii(
    req: PiiRequest,
    x_api_key: str | None = Header(default=None),
) -> PiiResponse:
    _check_api_key(x_api_key)
    from app.service import get_pii_service

    result = get_pii_service().detect(
        text=req.text,
        confidence_threshold=req.confidence_threshold,
        enabled_categories=req.enabled_categories,
    )
    return PiiResponse(
        hasPii=result["hasPii"],
        entities=[PiiEntity(**e) for e in result["entities"]],
    )
