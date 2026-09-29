"""
Pydantic models for the guard service.

The /pii wire models live here (not in the router) so the request contract is
importable — and therefore testable in the model-free CI job, which installs
pydantic but not FastAPI — without the router's import chain.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

# ── Organisation-defined ("custom") labels ────────────────────────────────
# An org admin names a kind of data only their organisation has ("internal
# project code name") and GLiNER is asked for it zero-shot. On the wire each
# one is an OPAQUE id plus the prompt the model reads; the id is what comes
# back as the entity's category and label, so no response, log line or cache
# key ever needs to carry the prompt itself.
CUSTOM_LABEL_ID_PATTERN = r"^cdt_[0-9a-f]{10}$"
# One label group per request (see detection._custom_units): six prompts keep
# it inside the width the shipped groups were measured at.
MAX_CUSTOM_LABELS = 6
CUSTOM_PROMPT_MAX_CHARS = 60


def _check_prompt(value: str) -> str:
    """Printable text only, and nothing that looks like GLiNER's own framing.

    The model reads a label set as ``<<ENT>> prompt <<ENT>> prompt <<SEP>>``;
    a prompt carrying ``<<`` or ``>>`` could forge a marker and split itself
    into two labels. Control characters have no business in a label either.
    """
    if "<<" in value or ">>" in value:
        raise ValueError("prompt must not contain '<<' or '>>'")
    if not value.isprintable():
        raise ValueError("prompt must be printable text")
    return value


CustomLabelId = Annotated[str, StringConstraints(pattern=CUSTOM_LABEL_ID_PATTERN)]
CustomPrompt = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=2, max_length=CUSTOM_PROMPT_MAX_CHARS
    ),
    AfterValidator(_check_prompt),
]


def _require_distinct_prompts(prompts: list[str]) -> None:
    """Prompts must differ case-insensitively: gliner rejects exact duplicates
    in one label set, and two spellings of one prompt would compete for the
    same span inside a single softmax."""
    folded = [p.strip().casefold() for p in prompts]
    if len(set(folded)) != len(folded):
        raise ValueError("prompts must be unique (case-insensitive)")


class CustomLabel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: CustomLabelId
    prompt: CustomPrompt
    # The acceptance floor AT the slider anchor (0.70); the request's
    # confidence_threshold shifts it exactly like a built-in category's floor.
    floor: float = Field(..., ge=0.10, le=0.99)


class HealthResponse(BaseModel):
    status: str
    service: str
    cache: str = "unknown"
    pii_model: str = "unknown"
    # Populated so a failed model load is observable instead of silent
    # (BFSF-269): backend is "onnx-fp32"/"pytorch-fp32" once loaded, and
    # load_error carries the exception string when the load failed.
    backend: str | None = None
    load_error: str | None = None
    # Opaque digest of the detection engine (model + onnx graph + label
    # grouping + tier). Consumers key their own scan caches on it: a cache with
    # no expiry must invalidate when the thing that produces detections changes,
    # and `backend` is identical across a model swap or a tier flip.
    engine: str | None = None
    # API-contract version (app/main.py SERVICE_VERSION), NOT the engine
    # identity above: the server reads it before sending request fields an
    # older build would reject (U9 — /pii rejects unknown fields since 2.1).
    # The "0" default is the fail-safe for an unstamped construction: a probe
    # then treats the build as pre-versioned and withholds new fields.
    version: str = "0"


class PiiRequest(BaseModel):
    # Reject unknown fields: without extra="forbid", Pydantic v2 silently
    # drops what this build doesn't know, so a Node server newer than this
    # guard would have e.g. a narrowing filter quietly ignored instead of
    # getting a loud 422 (U9). Wire-parity today:
    # server/core/privacy/piiDetection/guardClient.js:62-66 sends exactly
    # {text, confidence_threshold, enabled_categories}, plus custom_labels
    # once /health reports version >= 2.3.0.
    model_config = ConfigDict(extra="forbid")

    text: str = Field(..., description="Text to scan for PII entities")
    confidence_threshold: float = Field(0.7, ge=0.0, le=1.0)
    enabled_categories: list[str] | None = Field(
        None,
        description="Restrict detection to these category keys (null = all categories)",
    )
    enabled_regions: list[str] | None = Field(
        None,
        description=(
            "Restrict country-specific patterns to these ISO 3166-1 alpha-2 codes "
            "(null = the pod default, GUARD_PII_REGIONS). Narrowing this also "
            "narrows which categories the regex tier claims, so GLiNER keeps "
            "answering for identifiers no active region has a pattern for."
        ),
    )
    custom_labels: list[CustomLabel] | None = Field(
        None,
        max_length=MAX_CUSTOM_LABELS,
        description=(
            "Organisation-defined kinds of data, asked of GLiNER zero-shot. "
            "Results come back in custom_entities, never in entities. With a "
            "non-empty list, enabled_categories=[] means NO built-in categories "
            "(without it, [] keeps meaning all of them)."
        ),
    )

    @model_validator(mode="after")
    def _distinct_custom_labels(self) -> "PiiRequest":
        labels = self.custom_labels or []
        ids = [label.id for label in labels]
        if len(set(ids)) != len(ids):
            raise ValueError("custom_labels ids must be unique")
        _require_distinct_prompts([label.prompt for label in labels])
        return self


class PiiEntity(BaseModel):
    text: str
    category: str
    label: str
    confidence: float
    offset: int
    length: int


class CustomPiiEntity(PiiEntity):
    """A span found for one of the request's custom labels.

    A subclass rather than a ``source`` field on PiiEntity, so the built-in
    ``entities`` keep exactly the shape they had before custom labels existed.
    ``category`` and ``label`` are both the custom label's opaque id.
    """

    source: Literal["model_custom"] = "model_custom"


class PiiResponse(BaseModel):
    hasPii: bool
    entities: list[PiiEntity]
    # True when the GLiNER tier could not run (model not ready / all
    # predictions failed) or only a prefix of an oversize input was scanned —
    # i.e. the entity list is likely incomplete. The Node side applies the org
    # fail-open/closed policy instead of trusting an under-redacted result
    # (BFSF-269).
    degraded: bool = False
    degraded_reason: str | None = None
    # WHICH categories lost coverage, when that is knowable (a label group whose
    # every inference call raised). Additive and optional, same pattern as
    # tier_mode. Under model-only `off` runs 7 label groups instead of 4, so a
    # transient ORT error is ~75% more likely per request AND degrades the whole
    # response — an org scoped to {Email, PhoneNumber} would be blocked because
    # the government-id group died. With this list the caller fails closed only
    # when a category it actually asked for is in here.
    #
    # ABSENT or EMPTY means "assume every category is affected" (e.g. a partial
    # scan of oversize input, where the unscanned tail can hide anything). It
    # must never be read as "nothing was affected".
    degraded_categories: list[str] | None = None
    # Set only on a partial scan of oversize input: the region [0,
    # processed_chars) was scanned; the caller fails closed on the tail.
    processed_chars: int | None = None
    total_chars: int | None = None
    # Which detection tier produced this result ("on" | "shadow" | "off" —
    # see GUARD_PII_REGEX_TIER). Additive and optional, so an older Node
    # client that doesn't know the field is unaffected; it exists so a log
    # line or eval run during a staged rollout is attributable to a mode.
    tier_mode: str | None = None
    # Identity of everything that decided this answer (model, ONNX graph, label
    # grouping, tier, effective regions, image build). Callers that memoise
    # results key on it: without it, a cache with no expiry keeps serving the
    # previous engine's verdicts after an upgrade, which is a silent
    # under-redaction rather than a stale number.
    engine_fingerprint: str | None = None
    # Spans for the request's custom_labels, resolved among themselves only.
    # OMITTED from the JSON (not null) when the request had no custom labels,
    # so a response to an older caller is byte-identical to what it was.
    custom_entities: list[CustomPiiEntity] | None = Field(
        None, exclude_if=lambda value: value is None
    )


class ProbeRequest(BaseModel):
    """Raw model candidates for tuning a custom label (POST /pii/probe).

    Same forbid contract as PiiRequest. Deliberately no threshold, categories
    or regions: the probe answers "what would the model propose, and how sure
    is it", and the caller fits a floor to those scores.
    """

    model_config = ConfigDict(extra="forbid")

    texts: list[Annotated[str, StringConstraints(max_length=4000)]] = Field(
        ..., min_length=1, max_length=8
    )
    label_set: dict[CustomLabelId, CustomPrompt] = Field(
        ..., min_length=1, max_length=MAX_CUSTOM_LABELS
    )

    @model_validator(mode="after")
    def _distinct_prompts(self) -> "ProbeRequest":
        _require_distinct_prompts(list(self.label_set.values()))
        return self


class ProbeCandidate(BaseModel):
    text_idx: int
    label: str
    start: int
    end: int
    score: float


class ProbeResponse(BaseModel):
    candidates: list[ProbeCandidate]
    model_ready: bool


class DisclosureRequest(BaseModel):
    # Same extra="forbid" contract as PiiRequest, for the same reason (U9): a
    # threshold this build does not know must be a loud 422, never a silent
    # drop that leaves the caller believing it narrowed something.
    #
    # Wire-parity today: server/core/privacy/disclosureClassifier.js sends
    # exactly {text}. Nothing else may be added to that payload — no agent id,
    # no agent name, no org id, no tenant reference (BFSF-441). The classifier
    # needs the sentence; it has no use for whose sentence it is, and a field
    # that is not on this model cannot be sent by accident.
    model_config = ConfigDict(extra="forbid")

    text: str = Field(..., description="Text to classify for an AI disclosure")


class DisclosureResponse(BaseModel):
    # THREE-VALUED, and the third value is the point. null is "no answer" —
    # no encoder baked, input too large, encode failed, or the two anchor banks
    # landed too close together to call. It is not "no disclosure": a caller
    # that flattens null to false turns "nobody looked" into "this duty is
    # open", and a caller that flattens it the other way closes one. The Node
    # client keeps the three apart (core/privacy/disclosureClassifier.js).
    disclosed: bool | None = None
    # Cosine to the nearest POSITIVE anchor, and how far it beat the nearest
    # negative one by. Both are here so a verdict can be argued with rather
    # than only believed — a margin of 0.004 and a margin of 0.4 are very
    # different claims and a bare boolean hides which one you have.
    similarity: float | None = None
    margin: float | None = None
    # The id of one of OUR OWN anchor sentences (app/services/disclosure/
    # anchors.py) — never a fragment of the submitted text. Enough to explain
    # a verdict in an evidence chain without quoting either side.
    matched_anchor: str | None = None
    # How many sentence-sized pieces the text was cut into. A text that
    # produced zero is a text nothing could be said about.
    segments: int = 0
    # Same meaning as on PiiResponse: the result may be incomplete or absent.
    # `degraded` and `disclosed is None` always travel together here.
    degraded: bool = False
    degraded_reason: str | None = None
    # Identity of everything that decided this — model dir, embedding width
    # AND the anchor bank, because the anchors are the classifier. Editing one
    # anchor sentence changes every verdict while the model id and image stay
    # identical, so a caller that memoises must key on this.
    engine_fingerprint: str | None = None
