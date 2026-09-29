"""Check the eval corpus: ids, fields, label sets and quotas. Pure stdlib.

    python corpus/check_corpus.py          # from classify-service/eval/

Exits 1 and names every failed check. The quotas are the corpus contract in
../README.md: about 55% Dutch, about 20% multi-label, about 15% with no label,
at least 12 long emails, and every label gold at least twice in every split,
so that no class in a macro-F1 rests on a single item.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SPLITS = {"dev": 120, "heldout": 80}
KINDS = ("email", "filename", "filecontent", "form")
LANGS = ("nl", "en")
FIELDS = ("id", "kind", "lang", "text", "labels")

# A long email is one that cannot fit in a 512-token window. Measured with the
# mDeBERTa (gliclass, GLiNER2.5) and XLM-R (bge-m3) tokenizers, every email of
# 2,000+ characters in this corpus is 548+ tokens, and every other item is
# under 710 characters. Characters keep this check model-free.
LONG_CHARS = 2000

QUOTAS = {
    "nl_share": (0.50, 0.60),
    "multi_share": (0.15, 0.25),
    "none_share": (0.10, 0.20),
    "kind_share_min": 0.15,
    "long_emails_per_split_min": 5,
    "long_emails_total_min": 12,
    "gold_per_label_min": 2,
    "split_size_tolerance": 0.10,
}


def load(split: str) -> list[dict]:
    with open(os.path.join(HERE, f"items.{split}.jsonl"), encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_labelsets() -> dict[str, list[str]]:
    with open(os.path.join(HERE, "labelsets.json"), encoding="utf-8") as fh:
        raw = json.load(fh)
    return {kind: [label["en"] for label in raw[kind]["labels"]] for kind in KINDS}


def is_long(item: dict) -> bool:
    return item["kind"] == "email" and len(item["text"]) >= LONG_CHARS


def check_items(
    items: list[dict], labelsets: dict[str, list[str]], split: str
) -> list[str]:
    errors = []
    for item in items:
        missing = [f for f in FIELDS if f not in item]
        if missing:
            errors.append(f"{split}: {item.get('id', '?')} lacks {missing}")
            continue
        if item["kind"] not in KINDS:
            errors.append(f"{split}: {item['id']} has unknown kind {item['kind']!r}")
            continue
        if item["lang"] not in LANGS:
            errors.append(f"{split}: {item['id']} has unknown lang {item['lang']!r}")
        if not item["text"].strip():
            errors.append(f"{split}: {item['id']} has an empty text")
        if len(set(item["labels"])) != len(item["labels"]):
            errors.append(f"{split}: {item['id']} repeats a gold label")
        for label in item["labels"]:
            if label not in labelsets[item["kind"]]:
                errors.append(
                    f"{split}: {item['id']} gold {label!r} is not in the {item['kind']} label set"
                )
    return errors


def _share_error(split: str, name: str, value: float) -> str | None:
    lo, hi = QUOTAS[name]
    return (
        None
        if lo <= value <= hi
        else f"{split}: {name} {value:.2f} outside [{lo}, {hi}]"
    )


def check_quotas(
    items: list[dict], labelsets: dict[str, list[str]], split: str
) -> list[str]:
    n = len(items)
    expected = SPLITS[split]
    errors = []
    if abs(n - expected) > expected * QUOTAS["split_size_tolerance"]:
        errors.append(f"{split}: {n} items, expected about {expected}")
    shares = {
        "nl_share": sum(i["lang"] == "nl" for i in items) / n,
        "multi_share": sum(len(i["labels"]) > 1 for i in items) / n,
        "none_share": sum(not i["labels"] for i in items) / n,
    }
    errors += [e for name, v in shares.items() if (e := _share_error(split, name, v))]
    for kind, count in Counter(i["kind"] for i in items).items():
        if count / n < QUOTAS["kind_share_min"]:
            errors.append(f"{split}: kind {kind} is only {count}/{n}")
    long_n = sum(is_long(i) for i in items)
    if long_n < QUOTAS["long_emails_per_split_min"]:
        errors.append(f"{split}: only {long_n} long emails")
    gold = Counter((i["kind"], label) for i in items for label in i["labels"])
    for kind, labels in labelsets.items():
        for label in labels:
            if gold[(kind, label)] < QUOTAS["gold_per_label_min"]:
                errors.append(
                    f"{split}: {kind}:{label!r} is gold only {gold[(kind, label)]}x"
                )
    return errors


def summarise(items: list[dict], split: str) -> str:
    n = len(items)
    kinds = Counter(i["kind"] for i in items)
    return (
        f"{split}: {n} items | "
        + " ".join(f"{k}={kinds[k]}" for k in KINDS)
        + f" | nl={sum(i['lang'] == 'nl' for i in items) / n:.0%}"
        + f" multi={sum(len(i['labels']) > 1 for i in items) / n:.0%}"
        + f" none={sum(not i['labels'] for i in items) / n:.0%}"
        + f" long_emails={sum(is_long(i) for i in items)}"
    )


def main() -> int:
    labelsets = load_labelsets()
    errors: list[str] = []
    seen_ids: dict[str, str] = {}
    seen_texts: dict[str, str] = {}
    long_total = 0
    for split in SPLITS:
        items = load(split)
        errors += check_items(items, labelsets, split)
        for item in items:
            if item["id"] in seen_ids:
                errors.append(
                    f"duplicate id {item['id']} ({seen_ids[item['id']]} and {split})"
                )
            seen_ids[item["id"]] = split
            if item["text"] in seen_texts:
                errors.append(
                    f"{item['id']} repeats the text of {seen_texts[item['text']]}"
                )
            seen_texts[item["text"]] = item["id"]
        errors += check_quotas(items, labelsets, split)
        long_total += sum(is_long(i) for i in items)
        print(summarise(items, split))
    if long_total < QUOTAS["long_emails_total_min"]:
        errors.append(f"only {long_total} long emails in total")
    for e in errors:
        print("FAIL", e)
    print("OK" if not errors else f"{len(errors)} check(s) failed")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
