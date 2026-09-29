"""Scratch /pii shim for measuring a GLiNER2 candidate model — NOT a runtime.

Route B of the model track: fastino/gliner2-privacy-filter-PII-multi does not
load through the `gliner` package (verified: no gliner config in the repo
snapshot), so it cannot ride the in-process eval path. This shim stands the
candidate up behind the SAME /pii contract the guard serves, so the whole
harness — run_eval --endpoint, calibrate --endpoint, the gate — runs against
it unchanged.

Deliberate properties:
  * the `gliner2` dependency lives ONLY in this image (see Dockerfile) — the
    no-new-runtime-dependency invariant holds during the experiment;
  * NO Redis and no caching of any kind, so timings and results can never be
    cache-polluted (run_eval's suspected_cache_hits check stays honest);
  * `?fuse=regex` reuses the REAL production arbitration — detect_regex_pii +
    _apply_validators + PiiService._finalise are imported from app/, not
    reimplemented — so the fused numbers measure the candidate inside the
    actual pipeline it would ship into;
  * chunking is the conservative char fallback (900/100, verbatim slices —
    mirrors pii.py's _chunk_text_chars semantics), NOT token-aware chunking.
    Adoption via Route B therefore requires an in-process re-measurement
    after a real adapter is built; these numbers bound, they do not bless.

Run (from guard-service/):
    docker build -t candidate-shim:fastino -f tools/candidate_shim/Dockerfile .
    docker run --rm -p 8199:8199 candidate-shim:fastino
    python -m eval.run_eval --endpoint http://127.0.0.1:8199/pii --split dev \
        --out eval/metrics.fastino.dev.raw.json
    python -m eval.run_eval --endpoint "http://127.0.0.1:8199/pii?fuse=regex" ...
"""

from __future__ import annotations

import json
import os

from fastapi import FastAPI
from pydantic import BaseModel

MODEL_ID = os.environ.get("CANDIDATE_MODEL", "fastino/gliner2-privacy-filter-PII-multi")
MAP_PATH = os.environ.get("CANDIDATE_MAP", "/app/eval/candidate_maps/fastino.json")
# Optional per-category floors (calibrate.py output, either shape). Applied in
# the shim because --thresholds only patches the in-process service.
FLOORS_PATH = os.environ.get("CANDIDATE_FLOORS", "")
# Query low, filter later — the same rationale as _group_floor (pii.py): the
# threshold participates in greedy span decoding, so querying at the accept
# floor silently loses candidates that calibration could have kept.
QUERY_FLOOR = float(os.environ.get("CANDIDATE_QUERY_FLOOR", "0.10"))
CHUNK_CHARS = 900
CHUNK_OVERLAP = 100

app = FastAPI()

with open(MAP_PATH, encoding="utf-8") as fh:
    _map_doc = json.load(fh)
TYPE_TO_CATEGORY: dict[str, str] = _map_doc["map"]

_floors: dict[str, float] = {}
if FLOORS_PATH and os.path.isfile(FLOORS_PATH):
    with open(FLOORS_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    if "proposals" in raw:
        raw = {
            c: p["proposed_floor"]
            for c, p in raw["proposals"].items()
            if p.get("proposed_floor") is not None
        }
    _floors = {k: float(v) for k, v in raw.items()}

_model = None
_seen_unmapped: set[str] = set()


def _get_model():
    global _model
    if _model is None:
        from gliner2 import GLiNER2

        _model = GLiNER2.from_pretrained(MODEL_ID)
    return _model


def _chunks(text: str):
    """Verbatim overlapping slices so char offsets stay absolute."""
    if len(text) <= CHUNK_CHARS:
        yield 0, text
        return
    start = 0
    while start < len(text):
        end = min(start + CHUNK_CHARS, len(text))
        yield start, text[start:end]
        if end >= len(text):
            return
        start = end - CHUNK_OVERLAP


def _normalise_prediction(pred, chunk_text: str) -> list[dict]:  # noqa: C901
    """GLiNER2 output → [{type, text, start, end, confidence}].

    Handles both shapes the gliner2 API is known to produce:
      {"entities": {type: [{...}]}} and a flat list of dicts.
    """
    rows: list[dict] = []
    if isinstance(pred, dict):
        entries = pred.get("entities", pred)
        if isinstance(entries, dict):
            for etype, hits in entries.items():
                for h in hits or []:
                    rows.append(
                        {"type": etype, **(h if isinstance(h, dict) else {"text": h})}
                    )
        elif isinstance(entries, list):
            rows = [dict(h) for h in entries]
    elif isinstance(pred, list):
        rows = [dict(h) for h in pred]
    out = []
    for r in rows:
        etype = str(r.get("type") or r.get("label") or "")
        text = str(r.get("text") or "")
        start = r.get("start", r.get("offset"))
        end = r.get("end")
        if start is None and text:
            # No spans in the payload — locate the first occurrence. Good
            # enough for an experiment; flagged so it is never mistaken for
            # production-grade offset handling.
            start = chunk_text.find(text)
            if start < 0:
                continue
        if end is None:
            end = (start or 0) + len(text)
        conf = float(r.get("confidence", r.get("score", 0.0)) or 0.0)
        out.append(
            {
                "type": etype,
                "text": text,
                "start": int(start),
                "end": int(end),
                "confidence": conf,
            }
        )
    return out


class PiiRequest(BaseModel):
    text: str
    confidence_threshold: float = 0.7
    enabled_categories: list[str] | None = None
    enabled_regions: list[str] | None = None


@app.post("/pii")
def detect(req: PiiRequest, fuse: str = ""):
    model = _get_model()
    labels = sorted(TYPE_TO_CATEGORY)
    seen: set[tuple[int, int, str]] = set()
    entities: list[dict] = []

    for offset, chunk in _chunks(req.text):
        pred = model.extract_entities(
            chunk,
            labels,
            threshold=QUERY_FLOOR,
            include_confidence=True,
            include_spans=True,
        )
        for row in _normalise_prediction(pred, chunk):
            category = TYPE_TO_CATEGORY.get(row["type"])
            if category is None:
                if row["type"] not in _seen_unmapped:
                    _seen_unmapped.add(row["type"])
                    print(
                        f"[shim] unmapped type from model: {row['type']!r}", flush=True
                    )
                continue
            if req.enabled_categories and category not in req.enabled_categories:
                continue
            floor = _floors.get(category, req.confidence_threshold)
            if row["confidence"] < floor:
                continue
            start = offset + row["start"]
            length = row["end"] - row["start"]
            key = (start, length, category)
            if key in seen or length <= 0:
                continue
            seen.add(key)
            entities.append(
                {
                    "text": req.text[start : start + length],
                    "category": category,
                    "label": category,
                    "confidence": round(row["confidence"], 4),
                    "offset": start,
                    "length": length,
                    "source": "model",
                }
            )

    if fuse == "regex":
        # The REAL production pipeline around the candidate: regex tier +
        # arithmetic validators + overlap resolution, imported, not imitated.
        from app.services.pii import PiiService, _apply_validators
        from app.services.pii_regex import detect_regex_pii

        regex_entities = detect_regex_pii(req.text, enabled_regions=req.enabled_regions)
        for e in regex_entities:
            e.setdefault("source", "regex")
        merged = _apply_validators(regex_entities + entities)
        result = PiiService._finalise(merged, text=req.text, tier_mode="candidate")
        return {**result, "degraded": False, "degraded_reason": None}

    return {
        "hasPii": bool(entities),
        "entities": sorted(entities, key=lambda e: e["offset"]),
        "degraded": False,
        "degraded_reason": None,
        "tier_mode": "candidate",
    }


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID, "floors": bool(_floors)}
