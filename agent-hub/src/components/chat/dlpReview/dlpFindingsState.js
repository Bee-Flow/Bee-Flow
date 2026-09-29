/**
 * Merge auto-detected findings with the spans the user marked themselves in
 * the review UI, and collapse anything that overlaps into a disjoint set.
 *
 * This is a small client-side port of server/core/dlp/spanOverlap.js's
 * semantics (cluster transitively-overlapping spans, union the extent) —
 * not a shared module, since it renders highlights here rather than
 * splicing text. The server re-derives its own redaction from raw
 * offset/length when the user confirms (dlpPreflight.js), so this copy only
 * has to be good enough for the PREVIEW to look right; it is never the
 * source of truth for what actually gets redacted.
 */

let _manualIdSeq = 0;
export function nextManualId() {
    _manualIdSeq += 1;
    return `manual_${_manualIdSeq}`;
}

function usable(span) {
    return span && Number.isInteger(span.offset) && span.offset >= 0
        && Number.isInteger(span.length) && span.length > 0;
}

function collapse(cluster) {
    if (cluster.length === 1) return cluster[0];
    let offset = cluster[0].offset;
    let end = cluster[0].offset + cluster[0].length;
    for (const c of cluster) {
        if (c.offset < offset) offset = c.offset;
        if (c.offset + c.length > end) end = c.offset + c.length;
    }
    // A manual mark wins the label — the user is actively saying "this is
    // personal data", which should read as a correction even when it
    // overlaps something the detector already found. Otherwise the widest
    // (most specific) auto finding wins.
    const manual = cluster.find(s => s.source === 'manual');
    const winner = manual || cluster.reduce((a, b) => (b.length > a.length ? b : a));
    return { ...winner, offset, length: end - offset };
}

/**
 * @param {Array} autoFindings  Server findings, already carrying offset/length/category/confidenceBand/source/id/text.
 * @param {Array} manualSpans   Locally-added {id, offset, length, text}.
 * @returns {Array} Disjoint spans sorted by offset, each tagged `source`.
 */
export function mergeSpans(autoFindings, manualSpans) {
    const manual = (manualSpans || []).map(m => ({ ...m, source: 'manual', category: 'UserMarked', confidenceBand: null }));
    const all = [...(autoFindings || []), ...manual].filter(usable);
    if (all.length === 0) return [];

    all.sort((a, b) => a.offset - b.offset || (b.length - a.length));
    const out = [];
    let cluster = [all[0]];
    let clusterEnd = all[0].offset + all[0].length;
    for (const s of all.slice(1)) {
        if (s.offset < clusterEnd) {
            cluster.push(s);
            if (s.offset + s.length > clusterEnd) clusterEnd = s.offset + s.length;
        } else {
            out.push(collapse(cluster));
            cluster = [s];
            clusterEnd = s.offset + s.length;
        }
    }
    out.push(collapse(cluster));
    return out;
}

/**
 * Windowed spans for a sub-range of the document — e.g. one table cell out
 * of a whole spreadsheet's flat text. Returns only spans FULLY contained in
 * [start, end), translated to offsets local to that window (0 = `start`).
 * A span straddling the window's edge (shouldn't happen for a real PII value
 * against a cell boundary, since a value never spans a structural `|`) is
 * simply not rendered in this window — it is still redacted server-side
 * from the untouched absolute offsets kept on the un-windowed `spans` list.
 */
export function spansInRange(spans, start, end) {
    return (spans || [])
        .filter(s => s.offset >= start && s.offset + s.length <= end)
        .map(s => ({ ...s, offset: s.offset - start }));
}

/** Split `text` into alternating plain-text and span runs, in offset order. */
export function buildRuns(text, spans) {
    const runs = [];
    let cursor = 0;
    for (const s of spans) {
        if (s.offset > cursor) runs.push({ type: 'text', value: text.slice(cursor, s.offset) });
        runs.push({ type: 'span', ...s, value: text.slice(s.offset, s.offset + s.length) });
        cursor = s.offset + s.length;
    }
    if (cursor < text.length) runs.push({ type: 'text', value: text.slice(cursor) });
    return runs;
}
