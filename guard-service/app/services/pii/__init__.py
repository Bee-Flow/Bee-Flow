"""
CPU PII Detection — GLiNER (default model: E3-JSI/gliner-multi-pii-domains-v1)

Runs a GLiNER zero-shot NER model entirely on CPU. The model is the
single PII backend for the Bee-Flow server; when this container isn't
installed PII detection is off.

GLiNER labels are passed in at inference time (zero-shot). We map them
to the same standard PII category keys used in
`server/core/piiDetection.js` so the upstream Node.js code can rely
on a single unified category list regardless of which backend produced
the entities.

This is the entry point of the package; it only wires the parts together and
re-exports them, so ``from app.services.pii import X`` keeps meaning what it
meant when all of this was one file. What lives where:

    categories.py     the canonical category vocabulary and its two sets
    label_groups.py   which labels share a forward pass, and its digest
    thresholds.py     the per-category confidence floors and the slider anchor
    ranking.py        which category names an overlap cluster
    scan_policy.py    tier mode, regions, per-request scan budget
    noise.py          skippable text and common-noun Person/Org spans
    postprocess.py    boundary repair, shape filtering, validator arithmetic
    chunking.py       the tokenizer and the token/char chunkers
    inference.py      forward passes and chunking under the right lock
    model_loading.py  loading the model and warming it
    custom_labels.py  a request's organisation-defined labels (never global)
    detection.py      the two-tier pass producing unresolved candidates
    overlaps.py       resolving candidates into the response envelope
    fingerprint.py    identity of the configuration that produced a result
    cache.py          the cached async entry point and the inference gate
    probe.py          raw custom-label candidates for tuning (/pii/probe)
    service.py        the PiiService singleton that composes them
"""

from __future__ import annotations

import logging
import threading  # noqa: F401
import time  # noqa: F401
from collections import Counter  # noqa: F401
from concurrent.futures import ThreadPoolExecutor  # noqa: F401
from typing import Optional  # noqa: F401

logger = logging.getLogger("guard.pii")

# ── The public surface ─────────────────────────────────────────────────
# Re-exported EXACTLY as the single-file module exported it, underscored names
# included: the tests and the eval harness reach for the private helpers by
# name (``from app.services.pii import _pick_label``, ``_chunk_text``,
# ``_PER_CATEGORY_THRESHOLD`` …), so this list is a contract, not a
# convenience.
from .categories import (  # noqa: F401
    ALL_CATEGORIES,
    CATEGORY_LABELS,
    GLINER_LABELS_TO_CATEGORY,
    STRUCTURED_CATEGORIES,
)
from .label_groups import (  # noqa: F401
    _LABEL_GROUPS,
    _grouped_categories,
    _label_group_digest,
    label_groups,
    use_label_groups,
)
from .thresholds import (  # noqa: F401
    _ABSOLUTE_CEIL,
    _ABSOLUTE_FLOOR,
    _PER_CATEGORY_THRESHOLD,
    _UI_DEFAULT_THRESHOLD,
)
from .ranking import (  # noqa: F401
    _CATEGORY_PRECEDENCE,
    _CONTEXT_SEPARABLE_SIBLINGS,
    _SPECIFIC_OVER_GENERAL,
    _SPECIFICITY_BAND,
    _SPECIFICITY_MIN_COVERAGE,
    _label_margin,
    _pick_label,
)
from .scan_policy import (  # noqa: F401
    TIER_MODES,
    _TIER_SCAN_BUDGET_CHARS,
    _effective_regions,
    _scan_budget_chars,
    configured_regions,
    resolve_tier_mode,
)
from .noise import (  # noqa: F401
    _PERSON_ORG_STOPWORDS,
    _STOP_PARTICLES,
    _is_noise_person_org,
    _is_skippable,
)
from .postprocess import (  # noqa: F401
    _EXTENSION_SUFFIX_RE,
    _MIN_DIGITS_BY_CATEGORY,
    _OPAQUE_ID_RE,
    _TIME_OF_DAY_RE,
    _TRAILING_PUNCT,
    _TUSSENVOEGSEL_TAIL_RE,
    _apply_validators,
    _is_opaque_identifier,
    _postprocess_entities,
    _precision_filter,
    _re,
)
from .chunking import (  # noqa: F401
    _CHUNK_CHAR_LIMIT,
    _CHUNK_OVERLAP,
    _CUSTOM_CHUNK_CHAR_LIMIT,
    _ChunkBudget,
    _FALLBACK_MAX_LEN,
    _MIN_TEXT_TOKEN_BUDGET,
    _PRETRIM_MARGIN_CHARS,
    _TOKEN_BUDGET_SAFETY,
    _ThreadLocalTokenizer,
    _chunk_text,
    _chunk_text_chars,
    _chunk_text_tokens,
    _is_word_char,
    _label_prompt_tokens,
    _label_prompt_width,
    _label_prompt_width_max,
    _model_limits,
    _snap_boundary,
    _snap_start_to_word,
    _supports_offsets,
    _token_index_at_char,
)
from .inference import _MODEL_BATCH_SIZE  # noqa: F401
from .model_loading import _DEFAULT_MAX_PREDICT_WORKERS  # noqa: F401
from .custom_labels import (  # noqa: F401
    CUSTOM_SOURCE,
    _CustomSpec,
    custom_label_digest,
)
from .detection import ScanRequest  # noqa: F401
from .overlaps import _finalise_custom  # noqa: F401
from .fingerprint import (  # noqa: F401
    _ENGINE_FP_STATIC,
    _engine_fingerprint,
    engine_fingerprint_digest,
    reset_engine_fingerprint,
)
from .cache import (  # noqa: F401
    _CACHE_SCHEMA_VERSION,
    _get_inference_semaphore,
    _inference_semaphore,
    reset_inference_semaphore,
)
from .probe import ProbeUnavailable  # noqa: F401
from .service import (  # noqa: F401
    PiiService,
    _service,
    get_pii_service,
)


# ── Why there is no rebinding forwarder here any more ──────────────────
# There used to be one: assigning `app.services.pii.X = …` was mirrored onto
# every submodule that bound the same name, because while this was ONE file a
# rebind reached every reader, and three callers leaned on that.
#
# Mirroring writes through a custom module class is a mechanism nobody can see
# from the call site, and it had quietly become load-bearing: if it ever
# stopped working, an eval sweep would measure the shipped label grouping
# while believing it measured a candidate, and a memoised fingerprint would
# never be recomputed. Both fail the way this package must never fail —
# silently, and looking fine.
#
# All three now have a named seam instead:
#
#     _LABEL_GROUPS        -> label_groups() / use_label_groups(groups)
#     _ENGINE_FP_STATIC    -> reset_engine_fingerprint()
#     _inference_semaphore -> reset_inference_semaphore()
#
# The underscored names stay exported: the tests and the eval harness read
# them, and reading was never the problem. Writing was.
