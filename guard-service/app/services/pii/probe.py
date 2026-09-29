"""Raw model candidates for tuning a custom label: POST /pii/probe.

The admin's test bench asks "what does the model propose for these prompts on
these sentences, and how sure is it?" and fits a floor to the answer on the
Node side. So this returns what the model says BEFORE any decision: every
candidate at the query floor, after the same word-edge repair production
applies, with no per-label floor, no overlap resolution, no cache and no
built-in categories.

It shares production's pieces rather than copying them: the same canonical
label order (``_CustomSpec``), the same chunk list (``_custom_chunks``), the
same fan-out and the same repair. A floor fitted to these scores therefore
means the same thing on /pii. And like /pii it never writes to a global
table; the eval tools that do (eval/probe_labels.py, eval/calibrate.py) are
not a request path.
"""

from __future__ import annotations

import logging

from .cache import _get_inference_semaphore
from .custom_labels import _CustomSpec
from .detection import _ScanUnit, _scan_units, _Timings
from .postprocess import _postprocess_entities

logger = logging.getLogger("guard.pii")


class ProbeUnavailable(RuntimeError):
    """The probe cannot answer; ``reason`` is the router's 503 detail."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _raw_spans(
    text: str, units: list[_ScanUnit], outcomes: list, custom: _CustomSpec
) -> list[dict]:
    """Every span the model returned for one text, at document offsets.

    A failed pass is not a partial answer here: a tuning run on half the
    chunks would fit a floor to the wrong distribution, so it raises."""
    raw: list[dict] = []
    for unit, (batched, exc) in zip(units, outcomes):
        if exc is not None or batched is None:
            raise ProbeUnavailable("inference_failed")
        for spans, chunk_offset in zip(batched, unit[4]):
            for ent in spans:
                label = ent.get("label") or ""
                if not custom.knows(label):
                    continue
                start = chunk_offset + int(ent.get("start", 0))
                end = chunk_offset + int(ent.get("end", 0))
                raw.append(
                    {
                        "text": text[start:end],
                        "category": label,
                        "confidence": float(ent.get("score", 0)),
                        "offset": start,
                        "length": end - start,
                    }
                )
    return raw


def _candidates(text_idx: int, text: str, raw: list[dict]) -> list[dict]:
    """Word-edge repair, then one candidate per (label, extent) at its best
    score: overlapping chunks see the same span twice, and a repair can fold
    two clipped readings onto one extent."""
    best: dict[tuple[int, int, str], float] = {}
    for ent in _postprocess_entities(text, raw):
        key = (ent["offset"], ent["offset"] + ent["length"], ent["category"])
        best[key] = max(best.get(key, 0.0), ent["confidence"])
    return [
        {
            "text_idx": text_idx,
            "label": label,
            "start": start,
            "end": end,
            "score": round(score, 4),
        }
        for (start, end, label), score in sorted(best.items())
    ]


class _Probe:
    """``PiiService``'s tuning surface. Mixed into the service."""

    def probe(self, texts: list[str], label_set: dict[str, str]) -> list[dict]:
        """Raw candidates for ``label_set`` (``{id: prompt}``) on each text."""
        if not self._ready or self._model is None:
            raise ProbeUnavailable("model_not_ready")
        custom = _CustomSpec.for_probe(label_set)
        plans: list[tuple[int, str, list[_ScanUnit]]] = []
        for text_idx, text in enumerate(texts):
            if not text.strip():
                continue
            chunks, _processed, _total = self._custom_chunks(text, None, custom)
            plans.append((text_idx, text, _scan_units([custom.mapping], chunks)))

        # One queue for every text, so the passes fan out over the predict
        # pool together instead of one text at a time.
        units = [unit for _, _, text_units in plans for unit in text_units]
        outcomes, _workers = self._run_scan_units(units, _Timings())

        candidates: list[dict] = []
        cursor = 0
        for text_idx, text, text_units in plans:
            mine = outcomes[cursor : cursor + len(text_units)]
            cursor += len(text_units)
            raw = _raw_spans(text, text_units, mine, custom)
            candidates.extend(_candidates(text_idx, text, raw))
        return candidates

    async def probe_async(
        self, texts: list[str], label_set: dict[str, str]
    ) -> list[dict]:
        """probe() under the pod's inference gate, off the event loop: a
        tuning run is model work like any scan and queues with the scans."""
        import asyncio

        async with _get_inference_semaphore():
            return await asyncio.to_thread(self.probe, texts, label_set)
