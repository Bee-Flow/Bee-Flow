"""Corpus record schema, JSONL (de)serialisation, and load-time self-checks.

A record is one document with gold PII spans. The invariants enforced here
are what make the corpus trustworthy as a regression/calibration signal:

  * every span's char slice equals its recorded ``text`` (offsets are never
    hand-typed — see generate_corpus.py — but we verify anyway),
  * every ``category`` is one of the 21 canonical IDs,
  * spans are sorted by ``start`` and non-overlapping,
  * ``text`` is NFC-normalised so corpus char indices match what the service
    sees (``PiiService.detect`` slices the raw JSON string).

Pure stdlib: this module (and the whole matcher/metrics path) must run in the
guard container and model-free in CI, so no numpy/pydantic here.
"""

from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass, field, asdict
from typing import Iterable, Iterator


# ── The 21 canonical category IDs (the contract) ───────────────────────────
# Kept in sync with agent-hub/src/config/piiCategories.ts and
# server/core/piiDetection.js PII_CATEGORIES. A test in
# tests/test_eval_harness.py asserts the corpus only uses these.
CANONICAL_CATEGORIES: frozenset[str] = frozenset(
    {
        "Person",
        "DateOfBirth",
        "PhoneNumber",
        "Email",
        "Address",
        "CreditCardNumber",
        "BankAccountNumber",
        "InternationalBankingAccountNumber",
        "USSocialSecurityNumber",
        "PassportNumber",
        "DriversLicenseNumber",
        "IPAddress",
        "URL",
        "ApiKeyOrSecret",
        "Organization",
        "NationalIdentificationNumber",
        "TaxIdentificationNumber",
        "HealthInsuranceNumber",
        "MedicalCondition",
        "Medication",
        "LicensePlateNumber",
    }
)

VALID_SIZE_CLASSES: frozenset[str] = frozenset({"short", "large"})


class CorpusError(ValueError):
    """Raised when a corpus record violates a schema invariant."""


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    category: str
    text: str
    value_kind: str | None = None

    @property
    def length(self) -> int:
        return self.end - self.start

    def to_json(self) -> dict:
        d = {
            "start": self.start,
            "end": self.end,
            "category": self.category,
            "text": self.text,
        }
        if self.value_kind is not None:
            d["value_kind"] = self.value_kind
        return d

    @classmethod
    def from_json(cls, d: dict) -> "Span":
        return cls(
            start=int(d["start"]),
            end=int(d["end"]),
            category=str(d["category"]),
            text=str(d["text"]),
            value_kind=d.get("value_kind"),
        )


@dataclass(frozen=True)
class Record:
    id: str
    text: str
    spans: tuple[Span, ...]
    lang: str = "nl"
    size_class: str = "short"
    source: str = "synthetic"
    meta: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "lang": self.lang,
            "size_class": self.size_class,
            "source": self.source,
            "text": self.text,
            "spans": [s.to_json() for s in self.spans],
            "meta": self.meta,
        }

    @classmethod
    def from_json(cls, d: dict) -> "Record":
        return cls(
            id=str(d["id"]),
            text=str(d["text"]),
            spans=tuple(Span.from_json(s) for s in d.get("spans", [])),
            lang=str(d.get("lang", "nl")),
            size_class=str(d.get("size_class", "short")),
            source=str(d.get("source", "synthetic")),
            meta=dict(d.get("meta", {})),
        )

    @property
    def categories_present(self) -> set[str]:
        return {s.category for s in self.spans}


def normalize(text: str) -> str:
    """NFC-normalise so corpus char indices match the service's ``text[s:e]``."""
    return unicodedata.normalize("NFC", text)


def validate_record(rec: Record, *, strict_categories: bool = True) -> None:
    """Assert every schema invariant, raising ``CorpusError`` on the first breach.

    Runs model-free, so a malformed corpus fails CI without a model download.
    """
    if not rec.id:
        raise CorpusError("record has empty id")
    if rec.size_class not in VALID_SIZE_CLASSES:
        raise CorpusError(f"{rec.id}: invalid size_class {rec.size_class!r}")
    if rec.text != normalize(rec.text):
        raise CorpusError(f"{rec.id}: text is not NFC-normalised")

    n = len(rec.text)
    prev_end = -1
    for i, sp in enumerate(rec.spans):
        if strict_categories and sp.category not in CANONICAL_CATEGORIES:
            raise CorpusError(
                f"{rec.id}: span {i} has unknown category {sp.category!r}"
            )
        if not (0 <= sp.start < sp.end <= n):
            raise CorpusError(
                f"{rec.id}: span {i} offsets [{sp.start},{sp.end}) out of range (len={n})"
            )
        # The load-bearing check: the slice must equal the recorded text.
        actual = rec.text[sp.start : sp.end]
        if actual != sp.text:
            raise CorpusError(
                f"{rec.id}: span {i} slice {actual!r} != recorded text {sp.text!r}"
            )
        if sp.start < prev_end:
            raise CorpusError(
                f"{rec.id}: span {i} overlaps the previous span (start {sp.start} < prev end {prev_end})"
            )
        prev_end = sp.end


def load_jsonl(path: str, *, validate: bool = True) -> list[Record]:
    """Load a corpus JSONL file into validated ``Record``s."""
    records: list[Record] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = Record.from_json(json.loads(line))
            except (json.JSONDecodeError, KeyError) as exc:
                raise CorpusError(
                    f"{path}:{line_no}: malformed record ({exc})"
                ) from exc
            if validate:
                validate_record(rec)
            records.append(rec)
    return records


def dump_jsonl(records: Iterable[Record], path: str) -> int:
    """Write records as one JSON object per line. Returns the count written."""
    count = 0
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(
                json.dumps(rec.to_json(), ensure_ascii=False, separators=(",", ":"))
            )
            fh.write("\n")
            count += 1
    return count


def iter_all(paths: Iterable[str], *, validate: bool = True) -> Iterator[Record]:
    for p in paths:
        yield from load_jsonl(p, validate=validate)


__all__ = [
    "CANONICAL_CATEGORIES",
    "VALID_SIZE_CLASSES",
    "CorpusError",
    "Span",
    "Record",
    "normalize",
    "validate_record",
    "load_jsonl",
    "dump_jsonl",
    "iter_all",
    "asdict",
]
