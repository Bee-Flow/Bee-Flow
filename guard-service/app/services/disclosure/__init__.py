"""AI-disclosure classification — "does this text tell its reader AI was used".

The one place in Bee Flow's compliance surface where the research found a
model beating a rule, and the shape it is allowed to take: an EMBEDDING
classifier, deterministic, no generation and no prompt. It assists the keyword
rule in server/compliance/checks/aia/art50-ai-disclosure.js; it does not
replace it, and with no encoder baked into this image (the default) it answers
"no opinion" and the rule stands alone.

    anchors.py     the labelled sentences that ARE the classifier
    similarity.py  segmentation, cosine, and the three-way verdict (no deps)
    encoder.py     the optional, locally-baked sentence encoder
    service.py     the singleton that composes them
"""

from __future__ import annotations

from .anchors import (  # noqa: F401
    NEGATIVE_ANCHORS,
    POSITIVE_ANCHORS,
    anchor_ids,
    anchor_texts,
    bank_digest,
    positive_count,
)
from .encoder import SentenceEncoder  # noqa: F401
from .service import DisclosureService, get_disclosure_service  # noqa: F401
from .similarity import (  # noqa: F401
    MAX_SEGMENTS,
    MAX_SEGMENT_CHARS,
    MIN_SEGMENT_CHARS,
    best_similarity,
    cosine,
    segments,
    verdict,
)
