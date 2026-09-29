// @typecheck
/**
 * Overlap resolution for detected PII spans.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every consumer of a scan result eventually splices tokens into the text by
 * `offset`/`length`, from the tail forwards:
 *
 *     out = out.slice(0, offset) + token + out.slice(offset + length)
 *
 * That is only splice-safe for DISJOINT spans. Give it two spans that overlap
 * and the second splice's tail slice starts INSIDE the placeholder the first
 * one just wrote, so it eats part of it. The failure as it showed up in
 * production (names fictional):
 *
 *     [person_8] -> "Theodorus van der Brugrganization_1"
 *                                           ^^^ the "[o" of [organization_1]
 *
 * The value stored in the token map is then a string that never existed in the
 * user's text, and the next scan of that text detects the corrupted fragment as
 * a fresh entity — the damage compounds across turns.
 *
 * Overlaps are not exotic. `mergeWindowResults` used to dedupe on the exact
 * triple `offset:length:category`, so an entity clipped by an 8k window
 * boundary in window A and complete in window B — SAME offset, DIFFERENT
 * length — passed the dedupe as two distinct spans.
 *
 * THE RULE
 * --------
 * Cluster transitively-overlapping spans, keep the UNION of the cluster's
 * extent, and let the strongest member name it. Union (rather than "drop the
 * loser") is deliberate and mirrors the guard's own `_finalise` invariant
 * (`guard-service/app/services/pii.py`): no character that any detector flagged
 * may become unredacted by the act of resolving. Resolution can only ever
 * redact the same or more.
 *
 * Idempotent: an already-disjoint list comes back unchanged (modulo ordering),
 * so calling it twice on the same path costs nothing.
 */

// Matches dlpRunner's ordering; spans without a severity (the guard's model and
// regex entities) rank 0 and are compared on length, then confidence.
const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };

function _usableSpan(s) {
    return s
        && Number.isFinite(s.offset) && s.offset >= 0
        && Number.isFinite(s.length) && s.length > 0;
}

/** Is `a` the better label for a cluster than `b`? Severity → length → confidence. */
function _better(a, b) {
    const sa = SEVERITY_ORDER[a.severity] || 0;
    const sb = SEVERITY_ORDER[b.severity] || 0;
    if (sa !== sb) return sa > sb;
    if (a.length !== b.length) return a.length > b.length;
    return (a.confidence || 0) > (b.confidence || 0);
}

/**
 * Re-derive `text` from the source string so it always matches the span the
 * splice will replace. Without this a merged span keeps the winner's ORIGINAL
 * text while covering a wider extent — the token map would then restore a
 * shorter value than was removed, silently dropping characters.
 */
function _withText(span, source) {
    if (typeof source !== 'string') return span;
    const end = span.offset + span.length;
    if (end > source.length) return span;
    const sliced = source.slice(span.offset, end);
    return sliced === span.text ? span : { ...span, text: sliced };
}

function _collapse(cluster, source, better = _better, collectAlso = false) {
    if (cluster.length === 1) return _withText(cluster[0], source);
    let offset = cluster[0].offset;
    let end = cluster[0].offset + cluster[0].length;
    let winner = cluster[0];
    for (const c of cluster.slice(1)) {
        if (c.offset < offset) offset = c.offset;
        if (c.offset + c.length > end) end = c.offset + c.length;
        if (better(c, winner)) winner = c;
    }
    const merged = { ...winner, offset, length: end - offset };
    if (collectAlso) {
        // Every category the losers carried stays on the merged span, so a
        // policy keyed on a category (a tool block list) still sees it after
        // the label went to another member of the cluster.
        const also = new Set(Array.isArray(winner.alsoCategories) ? winner.alsoCategories : []);
        for (const c of cluster) {
            if (c.category) also.add(c.category);
            if (Array.isArray(c.alsoCategories)) c.alsoCategories.forEach(x => also.add(x));
        }
        also.delete(winner.category);
        if (also.size) merged.alsoCategories = [...also].sort();
    }
    return _withText(merged, source);
}

/**
 * Collapse overlapping spans into a disjoint set.
 *
 * @param {Array<object>} spans  Findings with `offset` + `length` (extra fields preserved).
 * @param {string|null}   source The text the offsets refer to. When given, each
 *                               returned span's `text` is re-derived from it.
 * @param {{ better?: (a: any, b: any) => boolean, collectAlso?: boolean }|null} [options]
 *   better:      who names a cluster (default: severity, then length, then
 *                confidence). The custom-type merge passes its own rule.
 *   collectAlso: record the other members' categories on the merged span as
 *                `alsoCategories`. Off by default, so every existing caller
 *                gets exactly what it got before.
 * @returns {Array<object>} Disjoint spans sorted by ascending offset. Spans with
 *                          no usable offset are passed through untouched at the
 *                          end (callers fall back to string replacement for them).
 */
function resolveSpanOverlaps(spans, source = null, options = null) {
    if (!Array.isArray(spans) || spans.length === 0) return [];

    const positioned = [];
    const passthrough = [];
    for (const s of spans) {
        (_usableSpan(s) ? positioned : passthrough).push(s);
    }
    if (positioned.length === 0) return passthrough;
    const better = typeof options?.better === 'function' ? options.better : _better;
    const collectAlso = options?.collectAlso === true;

    // Longest-first within an offset so a cluster opens on its widest member.
    positioned.sort((a, b) => a.offset - b.offset || b.length - a.length);

    const out = [];
    let cluster = [positioned[0]];
    let clusterEnd = positioned[0].offset + positioned[0].length;
    for (const s of positioned.slice(1)) {
        // Strictly-less: spans that merely touch (`s.offset === clusterEnd`) are
        // adjacent, not overlapping, and must stay separate tokens.
        if (s.offset < clusterEnd) {
            cluster.push(s);
            if (s.offset + s.length > clusterEnd) clusterEnd = s.offset + s.length;
        } else {
            out.push(_collapse(cluster, source, better, collectAlso));
            cluster = [s];
            clusterEnd = s.offset + s.length;
        }
    }
    out.push(_collapse(cluster, source, better, collectAlso));

    return [...out, ...passthrough];
}

module.exports = { resolveSpanOverlaps, defaultSpanBetter: _better };
