"""Wire models for the classify service. Every request model forbids unknown fields.

Kept apart from the router so the contract is importable, and testable,
without FastAPI's routing or the model.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_TEXTS = 32
MAX_LABELS = 16
MAX_LABEL_CHARS = 100

# The markers gliclass writes into the prompt it builds around a text
# (<<LABEL>>one<<LABEL>>two<<SEP>>text). Each is a single added token in the
# model's vocabulary. A label containing one would read to the model as two
# labels, and its scores would land on the wrong names, so labels may not
# contain them; texts are scrubbed of them before scoring instead
# (services/classifier.py), because a text is the user's data, not the author's.
RESERVED_MARKERS = ("<<LABEL>>", "<<SEP>>", "<<EXAMPLE>>")


class ClassifyRequest(BaseModel):
    # extra="forbid": a field this build does not know is a loud 422, never a
    # silent drop the caller would read as "understood".
    model_config = ConfigDict(extra="forbid")

    texts: list[str] = Field(..., min_length=1, max_length=MAX_TEXTS)
    labels: list[str] = Field(..., min_length=1, max_length=MAX_LABELS)
    # When sent, each result carries `matched`: the labels scoring >= it.
    threshold: float | None = Field(None, gt=0.0, lt=1.0)

    @field_validator("labels")
    @classmethod
    def _trimmed_unique_labels(cls, labels: list[str]) -> list[str]:
        # The messages name the rule, never the label: they travel back in the
        # 422 body, and nothing about a label belongs in a message we write.
        out: list[str] = []
        for raw in labels:
            label = raw.strip()
            if not label:
                raise ValueError("a label is empty after trimming")
            if len(label) > MAX_LABEL_CHARS:
                raise ValueError(f"a label is longer than {MAX_LABEL_CHARS} characters")
            if any(marker in label for marker in RESERVED_MARKERS):
                raise ValueError("a label contains a reserved prompt marker")
            if label in out:
                raise ValueError("labels must be unique after trimming")
            out.append(label)
        return out


class ClassifyResult(BaseModel):
    # label -> score in [0, 1], rounded to 4 decimals, in request label order.
    scores: dict[str, float]
    # True when the model saw less than the whole text (character cut or the
    # token window), so a caller can tell "not about X" from "not in the part
    # that was read".
    truncated: bool
    # Present only when the request carried a threshold.
    matched: list[str] | None = None


class ClassifyResponse(BaseModel):
    results: list[ClassifyResult]
    labels: list[str]
    model: str
    revision: str
    engine: str
    default_threshold: float
    ms: float


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    backend: str
    model: str
    revision: str
    engine: str
    default_threshold: float
    max_labels: int = MAX_LABELS
    max_texts: int = MAX_TEXTS
    max_chars: int
    label_mode: str
    load_error: str | None = None
