"""Shadow mode's one honest answer: would `off` have detected FEWER?

Category names and integer counts only, never offsets, spans or input.
"""

from __future__ import annotations

import logging
from collections import Counter

from .types import Entities, JsonDict

logger = logging.getLogger("guard.pii")


def _log_tier_diff(regex_entities: Entities, model_entities: Entities) -> None:
    def _cats(ents: list[JsonDict]) -> Counter[str]:
        return Counter(e["category"] for e in ents)

    regex_cats = _cats(regex_entities)
    model_cats = _cats(model_entities)
    logger.info(
        "pii.tier_diff regex_total=%d model_total=%d "
        "regex_only_categories=%s model_only_categories=%s "
        "regex_by_category=%s model_by_category=%s",
        sum(regex_cats.values()),
        sum(model_cats.values()),
        sorted(set(regex_cats) - set(model_cats)),
        sorted(set(model_cats) - set(regex_cats)),
        dict(sorted(regex_cats.items())),
        dict(sorted(model_cats.items())),
    )
