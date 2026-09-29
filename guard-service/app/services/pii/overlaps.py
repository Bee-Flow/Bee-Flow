"""Resolving overlapping candidate spans into the response envelope.

One rule with one guarantee: an emitted span's extent is the UNION of its
cluster, so ``union(kept) == union(input)`` and no character any detector
flagged can become unredacted. Which category NAMES that union is decided in
``ranking``; this module decides the extents, the containment handling and the
envelope fields the Node side reads.
"""

from __future__ import annotations

import logging
from typing import Optional

from .ranking import _SPECIFICITY_MIN_COVERAGE, _pick_label

logger = logging.getLogger("guard.pii")


class _OverlapResolution:
    """``PiiService``'s overlap resolver. Mixed into the service."""

    @staticmethod
    def _finalise(  # noqa: C901, PLR0913, PLR0915
        entities: list[dict],
        degraded: bool = False,
        degraded_reason: Optional[str] = None,
        degraded_categories: Optional[list[str]] = None,
        processed_chars: Optional[int] = None,
        total_chars: Optional[int] = None,
        tier_mode: Optional[str] = None,
        text: Optional[str] = None,
        near_miss_counts: Optional[dict] = None,
        scan_stats: Optional[dict] = None,
    ) -> dict:
        """Resolve overlaps and wrap in the response envelope.

        Overlap resolution used to be "keep the higher-confidence span",
        which worked only because regex hits carried 0.95-0.99 and therefore
        always won. Once every span comes from one model in one confidence
        band that rule breaks down, and measurably so: of 85 gold IBANs, 43
        were emitted as BankAccountNumber because the general label scored
        marginally higher on the identical span. IBAN *label* recall
        collapsed to 0.094 while its redaction coverage stayed at 0.988 —
        the value was redacted, under the wrong name.

        The old rule also had two latent bugs that the regex confidences
        were masking:

          * COVERAGE LOSS. ``kept[i] = ent`` replaced a kept span with an
            overlapping one, so A=[0,50) replaced by B=[45,60) silently
            un-redacted characters 0-45.
          * CONTAINMENT BY CONFIDENCE. A PhoneNumber strictly inside an
            Address could evict the Address and shrink the redaction.

        The rule now is:

          1. cluster transitively-overlapping spans;
          2. the emitted span's extent is the UNION of its cluster;
          3. if some span COVERS that union, only the covering spans compete
             for the label — the emitted span *is* the container, so the
             container's category is the one that describes it;
          4. among the competitors the category is chosen by confidence,
             EXCEPT within a 0.10 band where a more specific category beats a
             more general one (IBAN ⊂ BankAccountNumber, NationalId ⊂
             BankAccountNumber…).

        Rule 3 exists because the output is a FLAT, DISJOINT span list, so a
        cluster yields exactly one label no matter what. Letting a strictly
        contained span win that label mislabels the whole extent: a street
        address came back as ``URL`` (``[url_1]`` on "Ambachtsweg 103") and a
        phone inside a postal block would have taken the block. Rule 4 still
        does the work for identical extents, which is where the financial
        tuning lives (IBAN and BankAccountNumber cover the same digits).

        Rule 2 gives the invariant ``union(kept) == union(input)``: no
        character that any detector flagged can become unredacted. That is
        the anti-leak guarantee of this component and is property-tested.

        ``text`` (the scanned source) is required to keep ``entity["text"]``
        consistent with the widened ``offset``/``length``. Without it a merged
        span carries the winner's *original* text while the offsets describe
        the union — and the Node side stores ``entity.text`` in the token map
        while splicing by offset/length, so the value restores SHORTER than it
        was removed. Every production path passes it.

        ``degraded`` marks a result whose entity list may be incomplete. The
        Node side applies the org's fail-open/fail-closed policy to it.

        ``processed_chars``/``total_chars`` (when set) mark a partial scan of
        oversize input: only ``[0, processed_chars)`` was covered.
        """

        def _wrap(has_pii: bool, ents: list[dict]) -> dict:
            out = {
                "hasPii": has_pii,
                "entities": ents,
                "degraded": degraded,
                "degraded_reason": degraded_reason,
            }
            if processed_chars is not None:
                out["processed_chars"] = processed_chars
            if total_chars is not None:
                out["total_chars"] = total_chars
            if tier_mode is not None:
                out["tier_mode"] = tier_mode
            # Only meaningful alongside degraded=True. Emitted whenever it is
            # non-empty so an older Node client simply ignores it, and a
            # DEGRADED response with an EMPTY list keeps the old semantics
            # ("assume every category lost coverage") rather than reading as
            # "no category affected".
            if degraded_categories:
                out["degraded_categories"] = list(degraded_categories)
            # Near-miss counters ("<Category>:<reason>" -> count). Observability
            # only: the router logs them and the response model drops them.
            # Emitted only when non-empty so cached v4 entries and older
            # consumers see no shape change.
            if near_miss_counts:
                out["near_miss_counts"] = dict(near_miss_counts)
            # Per-scan diagnosability (chunks/groups/lock-wait; detect_async
            # adds sem-wait and cache disposition). Same contract: router
            # logs, response model drops.
            if scan_stats:
                out["scan_stats"] = dict(scan_stats)
            return out

        def _retext(ent: dict) -> dict:
            """Force ``ent["text"] == text[offset:offset+length]``.

            Applied to EVERY emitted entity, not just merged ones, so the
            invariant has no special case to get wrong later. Out-of-range
            spans are clamped rather than sliced, because Python slicing
            clamps silently and would reproduce the very short-text bug this
            defends against.
            """
            if text is None:
                return ent
            start = ent["offset"]
            end = start + ent["length"]
            if start < 0 or end > len(text):
                logger.warning(
                    "[PiiService] span [%d,%d) out of range (len=%d) — clamping",
                    start,
                    end,
                    len(text),
                )
                start = max(0, min(start, len(text)))
                end = max(start, min(end, len(text)))
                ent["offset"], ent["length"] = start, end - start
            ent["text"] = text[start:end]
            return ent

        if not entities:
            return _wrap(False, [])

        # Single sorted sweep into clusters of transitively-overlapping spans.
        # (The previous implementation compared each entity against every kept
        # one — fine at 780 spans, not at 21 active categories over a
        # multi-hundred-chunk document.)
        ordered = sorted(entities, key=lambda e: (e["offset"], -(e["length"])))
        clusters: list[list[dict]] = []
        cur: list[dict] = []
        cur_end = -1
        for ent in ordered:
            start = ent["offset"]
            end = start + ent["length"]
            if cur and start < cur_end:
                cur.append(ent)
                cur_end = max(cur_end, end)
            else:
                if cur:
                    clusters.append(cur)
                cur = [ent]
                cur_end = end
        if cur:
            clusters.append(cur)

        kept: list[dict] = []
        for cluster in clusters:
            if len(cluster) == 1:
                kept.append(_retext(cluster[0]))
                continue

            if text is None:
                # Refuse rather than emit a span whose text contradicts its
                # offsets. Reconstructing the union text from the members is
                # possible (a cluster is contiguous) but it would be a clever
                # path no production caller exercises — and therefore one that
                # is wrong the first time it runs. Every real caller has the
                # source text in scope.
                raise ValueError(
                    "_finalise: overlapping spans need the source text to keep "
                    "entity['text'] consistent with the merged offset/length"
                )

            start = min(e["offset"] for e in cluster)
            end = max(e["offset"] + e["length"] for e in cluster)
            union_len = end - start

            # Only spans that substantially COVER the union compete for its
            # label. The emitted span *is* the union, so a small contained
            # span must not name it: that is what produced `[url_1]` on the
            # street "Ambachtsweg 103", and it would equally let a phone
            # number rename a whole postal block.
            #
            # Substantially, not exactly: the IBAN/BankAccountNumber contest
            # this table exists for has genuine boundary jitter (a spaced IBAN
            # runs a few chars longer than the unspaced reading), and exact
            # equality would drop the measured 43-of-85 IBAN fix. A sub-part
            # rename is far below this bar (a phone inside an address block is
            # ~0.3 of it), so one threshold separates the two cleanly.
            contenders = [
                e
                for e in cluster
                if union_len and e["length"] / union_len >= _SPECIFICITY_MIN_COVERAGE
            ] or cluster

            # Which category names the union: arithmetic, then specificity,
            # then margin above each category's own floor, then a frozen
            # precedence. See _pick_label.
            best = _pick_label(contenders)

            winner = dict(best)
            winner["offset"] = start
            winner["length"] = end - start
            kept.append(_retext(winner))

        kept.sort(key=lambda e: e["offset"])
        return _wrap(True, kept)


def _custom_clusters(entities: list[dict]) -> list[list[dict]]:
    """Transitively-overlapping clusters, in offset order (same sweep as
    _finalise, kept separate so the built-in resolver stays untouched)."""
    ordered = sorted(entities, key=lambda e: (e["offset"], -(e["length"])))
    clusters: list[list[dict]] = []
    cur_end = -1
    for ent in ordered:
        end = ent["offset"] + ent["length"]
        if clusters and ent["offset"] < cur_end:
            clusters[-1].append(ent)
            cur_end = max(cur_end, end)
        else:
            clusters.append([ent])
            cur_end = end
    return clusters


def _finalise_custom(entities: list[dict], text: str, spec) -> list[dict]:
    """Resolve a request's CUSTOM spans among themselves into a disjoint list.

    Never together with the built-in candidates, and that is the contract, not
    an optimisation: built-in ``entities`` must be byte-identical with or
    without custom labels, so no custom span may join, widen or rename a
    built-in cluster. The caller merges the two lists under its own rule.

    Same extent guarantee as _finalise: a cluster is emitted as the UNION of
    its members, so nothing a custom label flagged becomes unredacted. Its
    label is the one whose score clears ITS OWN per-request floor by the widest
    margin (the custom analogue of _label_margin: each label has its own floor,
    so raw scores are not comparable), then the spec's canonical order. There
    is no specificity table and no validator here: an admin-defined kind of
    data carries no is-a relation and no checksum this service could know.

    ``spec`` is the request's _CustomSpec (``floor_for`` / ``rank``).
    """
    kept: list[dict] = []
    for cluster in _custom_clusters(entities):
        start = min(e["offset"] for e in cluster)
        end = max(e["offset"] + e["length"] for e in cluster)
        best = max(
            cluster,
            key=lambda e: (
                round(e["confidence"] - spec.floor_for(e["category"]), 9),
                -spec.rank(e["category"]),
            ),
        )
        winner = dict(best)
        winner["offset"] = start
        winner["length"] = end - start
        winner["text"] = text[start:end]
        kept.append(winner)
    return kept
