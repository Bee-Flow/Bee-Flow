"""Organisation-defined labels, scoped to ONE request.

An org admin describes a kind of data only their organisation has ("internal
project code name") and GLiNER is asked for it zero-shot, as one extra label
group. Everything about that group lives in a ``_CustomSpec`` built per
request and dropped with it.

The one rule this module exists for: NOTHING here may touch a process-wide
table. GLINER_LABELS_TO_CATEGORY, _PER_CATEGORY_THRESHOLD, label_groups() and
the ranking tables are shared by every request on the pod, and the floors in
them were fitted to the SHIPPED grouping. A custom label written into any of
them would leak one tenant's vocabulary into another tenant's scan, and into
the engine fingerprint every cache keys on. The eval tools that do patch those
tables (eval/probe_labels.py, eval/calibrate.py) are measurement harnesses,
never a request path.

Ids are opaque (``cdt_`` + 10 hex). They are what the model returns as the
label (gliner 0.2.29 takes a ``{name: prompt}`` mapping: the prompt is what
the model reads, the key is what it answers with), what the response carries
as category and label, and the only thing a log line may name. The prompt is
customer-authored text and is never logged.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from .thresholds import _ABSOLUTE_CEIL, _ABSOLUTE_FLOOR, _UI_DEFAULT_THRESHOLD

# Provenance tag on a custom span, and the ``source`` the response carries.
CUSTOM_SOURCE = "model_custom"


@dataclass(frozen=True)
class _CustomSpec:
    """The custom labels of one request, in CANONICAL order (sorted by id).

    Canonical rather than request order, because the order is part of what the
    model reads: the prompts share one forward pass, so reordering them can
    move a score. Sorting makes the answer a function of the label SET, which
    is what the cache key (sorted) and the fingerprint digest describe, and it
    makes a /pii/probe run over the same set score exactly like production.

    ``labels`` holds ``(id, prompt, floor)``; ``floor`` is the acceptance floor
    at the slider anchor, shifted per request exactly like a built-in one.
    """

    labels: tuple[tuple[str, str, float], ...]
    confidence_threshold: float = _UI_DEFAULT_THRESHOLD
    _index: dict[str, int] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "_index",
            {label_id: i for i, (label_id, _, _) in enumerate(self.labels)},
        )

    @classmethod
    def from_request(
        cls, custom_labels: list[dict] | None, confidence_threshold: float
    ) -> "_CustomSpec | None":
        """``None`` for an absent or EMPTY list: an empty list is no request
        for custom labels, and must behave (and key, and fingerprint) exactly
        like a caller that predates them."""
        if not custom_labels:
            return None
        labels = sorted(
            (str(lbl["id"]), str(lbl["prompt"]), float(lbl["floor"]))
            for lbl in custom_labels
        )
        return cls(tuple(labels), float(confidence_threshold))

    @classmethod
    def for_probe(cls, label_set: dict[str, str]) -> "_CustomSpec":
        """A spec for raw candidates: every floor at the query floor."""
        return cls(tuple(sorted((i, p, _ABSOLUTE_FLOOR) for i, p in label_set.items())))

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(label_id for label_id, _, _ in self.labels)

    @property
    def prompts(self) -> list[str]:
        return [prompt for _, prompt, _ in self.labels]

    @property
    def mapping(self) -> dict[str, str]:
        """``{id: prompt}``: what the model is handed, a fresh dict per call."""
        return {label_id: prompt for label_id, prompt, _ in self.labels}

    @property
    def label_to_category(self) -> dict[str, str]:
        """A custom label IS its category: the id is both."""
        return {label_id: label_id for label_id in self.ids}

    def knows(self, label_id: str) -> bool:
        return label_id in self._index

    def rank(self, label_id: str) -> int:
        return self._index[label_id]

    def floor_for(self, label_id: str) -> float:
        """The per-request floor, mirroring detection._acceptance_floor: the
        slider shifts it by (slider - anchor), clamped to the absolute range."""
        base = self.labels[self._index[label_id]][2]
        shifted = base + (self.confidence_threshold - _UI_DEFAULT_THRESHOLD)
        return min(_ABSOLUTE_CEIL, max(_ABSOLUTE_FLOOR, shifted))

    def cache_material(self) -> list[list]:
        """What decides a custom answer, canonically: id, prompt, base floor.

        The slider is NOT in here; it is already a component of the cache key
        in its own right."""
        return [[i, p, round(f, 4)] for i, p, f in self.labels]

    @property
    def digest(self) -> str:
        payload = json.dumps(
            self.cache_material(), ensure_ascii=False, separators=(",", ":")
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def custom_label_digest(custom_labels: list[dict] | None) -> str | None:
    """The fingerprint component for a request's custom labels, or None."""
    spec = _CustomSpec.from_request(custom_labels, _UI_DEFAULT_THRESHOLD)
    return spec.digest if spec is not None else None
