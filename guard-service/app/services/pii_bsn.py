"""The one detector that is NOT GLiNER: Dutch BSN, by checksum.

This module is a deliberate, documented, measured exception to "GLiNER
performs all PII detection". It exists for exactly one category and should
not grow.

WHY IT EXISTS
-------------
Measured on eval/corpus with the regex tier disabled, split by whether the
surrounding text names the category:

    anchored ("het burgerservicenummer is …")   62/62  recall 1.00, P 0.969
    unanchored (a bare nine-digit run)           1/23  recall 0.04

When the text says what the number is, the model is perfect and this module
is redundant. When it doesn't, a BSN is nine digits with no linguistic signal
whatsoever — there is nothing for a NER to read. Raising recall on that case
by label choice cost half the precision (`national id number` reached 11/23
at P 0.547) and still left most of them undetected.

The elfproef, by contrast, decides it arithmetically. That is information the
model does not have and cannot acquire from context. This is the narrow class
where a checksum genuinely beats a language model, and the reason the owner
approved a carve-out.

WHAT IT IS NOT
--------------
It is NOT a general pattern tier. `\\b\\d{9}\\b` does not *identify* anything —
every nine-digit run in the document matches it. The regex is a candidate
generator; the elfproef is the detector. Roughly 1 in 11 random nine-digit
numbers passes by chance, which is why the corpus deliberately contains
non-BSN nine-digit distractors ("Zaaknummer 111222333") — one of which
genuinely passes and is an unavoidable false positive of this approach.

SCOPE — read this before assuming the category is covered
---------------------------------------------------------
This is NL-ONLY. `NationalIdentificationNumber` also covers the Belgian
rijksregisternummer, German Steuer-ID, Spanish DNI, Italian codice fiscale
and UK NINO. None of them satisfy the elfproef, so for roughly a third of
that category (27 of 85 gold spans in the corpus) GLiNER is already the only
detector and this module contributes nothing. "BSN is handled by checksum"
is true; "NationalIdentificationNumber is handled by checksum" is not.

DELETING THIS
-------------
If a future model handles unanchored nine-digit BSNs, re-run
``eval/run_eval.py --tier gliner`` split by anchoring and delete this file.
Nothing else depends on it.
"""

from __future__ import annotations

import re

CATEGORY = "NationalIdentificationNumber"
LABEL = "National ID"

# Candidate generator, not a detector — see the module docstring.
_NINE_DIGITS = re.compile(r"\b\d{9}\b")

# A checksum-validated BSN is arithmetically certain, so it outranks any model
# span it overlaps in _finalise. That is the intended behaviour: where this
# module fires at all, it is the more reliable of the two detectors.
CONFIDENCE = 0.99


def is_valid_bsn(digits: str) -> bool:
    """Dutch elfproef.

    Weighted sum with the last digit negated must be a non-zero multiple
    of 11. Originally ported from
    server/core/emailTextUtils.js::isValidBsn.
    """
    if not (len(digits) == 9 and digits.isdigit()):
        return False
    weights = (9, 8, 7, 6, 5, 4, 3, 2, -1)
    total = sum(w * int(d) for w, d in zip(weights, digits))
    return total != 0 and total % 11 == 0


def detect_bsn(
    text: str, enabled_categories: frozenset[str] | None = None
) -> list[dict]:
    """Return checksum-valid BSN spans, in the same shape GLiNER spans use.

    Emits nothing when the category is disabled for the org. Overlap with a
    model span is resolved downstream by ``PiiService._finalise``.
    """
    if enabled_categories is not None and CATEGORY not in enabled_categories:
        return []
    if not text:
        return []

    out: list[dict] = []
    for m in _NINE_DIGITS.finditer(text):
        value = m.group(0)
        if not is_valid_bsn(value):
            continue
        out.append(
            {
                "text": value,
                "category": CATEGORY,
                "label": LABEL,
                "confidence": CONFIDENCE,
                "offset": m.start(),
                "length": len(value),
            }
        )
    return out


__all__ = ["CATEGORY", "CONFIDENCE", "detect_bsn", "is_valid_bsn"]
