// @typecheck
/**
 * Builds the transcript excerpt handed to the speaker-naming model — pure, no deps.
 *
 * WHY THIS EXISTS
 * A 100-minute meeting is ~154,000 characters (~1,540 chars/minute). The naming
 * step used to send `transcript.substring(0, 60000)` — the first ~39 minutes —
 * and silently discarded the rest. One real meeting introduced everybody at
 * 52:33: the strongest naming evidence in the recording, sitting 13 minutes
 * beyond the cut. People who said their names aloud came back as "Speaker A".
 *
 * The budget was never the problem — *which* 60,000 characters was. So instead
 * of a prefix, select for naming evidence: lines that mention a person, the rare
 * speaker IDs a prefix never reaches, then an even spread for context.
 *
 * WHY CONTIGUOUS WINDOWS, NOT A STRIDE
 * Naming evidence is relational — it lives in adjacency. "Tom, wat denk jij?"
 * only identifies Tom because of the turn that answers it. A stride sample
 * maximises temporal coverage while severing exactly those pairs; an isolated
 * "Ja, precies." carries no signal at all. Windows keep local dialogue intact.
 *
 * WHY SEGMENTS IN, STRING OUT
 * This operates on the structured segments and renders the text itself. The
 * earlier version took the rendered string and regex-parsed it back into
 * speaker/timestamp/text — re-deriving, badly, data the caller already had.
 * Rendering here also yields the char offsets of every segment for free, which
 * is what lets NER spans be attributed to a speaker without any parsing.
 */

const GAP_MARKER = '[…]';
const DEFAULT_MAX_CHARS = 60000;

/**
 * Render segments into the transcript string, recording each segment's range.
 *
 * @param {Array<{speaker?: string, speakerId?: string, start: number, end: number, text: string}>} segments
 * @param {function} formatTime  Seconds → display stamp.
 * @returns {{text: string, offsets: Array<{start: number, end: number, bodyStart?: number}>, lines: string[]}}
 */
function renderTranscript(segments, formatTime) {
    const list = Array.isArray(segments) ? segments : [];
    const lines = [];
    const offsets = [];
    let cursor = 0;

    for (const seg of list) {
        const id = seg.speaker || seg.speakerId || 'Unknown';
        const prefix = `[${id}] ${formatTime(seg.start)} - ${formatTime(seg.end)}: `;
        const line = `${prefix}${(seg.text || '').trim()}`;
        lines.push(line);
        // `bodyStart` is where the SPOKEN text begins. The prefix contains the
        // speaker label, which on the re-identify path is already a real name —
        // so a person-name detector run over the whole line found "Tom" inside
        // "[Tom] 00:00 - 00:05:" and recorded it as evidence that this speaker
        // said their own name. Perfectly circular: it confirms whatever label is
        // already there and makes a wrong name impossible to correct.
        offsets.push({ start: cursor, end: cursor + line.length, bodyStart: cursor + prefix.length });
        cursor += line.length + 1; // +1 for the '\n' used to join
    }

    return { text: lines.join('\n'), offsets, lines };
}

/**
 * Build the excerpt.
 *
 * @param {Array} segments               Structured segments (same array rendered above).
 * @param {string[]} lines               Rendered lines, index-aligned with segments.
 * @param {object} [opts]
 * @param {number}   [opts.maxChars]     Character budget (default 60000).
 * @param {number[]} [opts.nameLines]    Segment indices mentioning a person, from speakerEvidence.
 * @param {number}   [opts.windowLines]  Lines per spread window (default 12).
 * @returns {{excerpt: string, stats: object}}
 */
function buildSpeakerNamingExcerpt(segments, lines, opts = {}) {
    const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
    const windowLines = opts.windowLines || 12;

    const list = Array.isArray(lines) ? lines : [];
    const segs = Array.isArray(segments) ? segments : [];
    const full = list.join('\n');

    // Short-circuit: most meetings fit. Keep them byte-identical to before, so
    // this can only affect the long recordings that were actually broken.
    if (full.length <= maxChars) {
        return {
            excerpt: full,
            stats: { kept: full.length, total: full.length, truncated: false, lines: list.length },
        };
    }

    const keep = new Set();
    let used = 0;
    let runs = 0; // contiguous blocks of kept lines; markers = runs - 1

    // The budget must cover the gap markers assemble() will insert, not just the
    // line text — otherwise a fragmented excerpt silently overflows.
    const cost = (extraChars, extraRuns) =>
        used + extraChars + Math.max(0, (runs + extraRuns) - 1) * (GAP_MARKER.length + 1);

    const add = (i) => {
        if (i < 0 || i >= list.length || keep.has(i)) return false;
        // Adding a line joins two runs (-1), extends one (0), or starts one (+1).
        const prev = keep.has(i - 1);
        const next = keep.has(i + 1);
        const runDelta = (prev && next) ? -1 : (prev || next) ? 0 : 1;
        const chars = list[i].length + 1;
        if (cost(chars, runDelta) > maxChars) return false;
        keep.add(i);
        used += chars;
        runs += runDelta;
        return true;
    };

    // 1. Every line where a person is named, plus its immediate neighbours.
    //    This is the evidence the naming decision actually rests on: the line
    //    itself, and the reply that reveals who was being addressed.
    for (const i of (opts.nameLines || [])) {
        if (add(i)) { add(i - 1); add(i + 1); }
    }

    // 2. Rare speaker IDs, rarest first. These are precisely the IDs that come
    //    back as "Speaker A": a prefix never reaches their few late turns.
    for (const { index } of rarestFirst(segs, keep)) {
        for (let d = 0; d < 3; d++) add(index + d);
    }

    // 3. Even spread over whatever budget is left, as contiguous windows.
    spread(list, add, windowLines, () => maxChars - cost(0, 0));

    const ordered = [...keep].sort((a, b) => a - b);
    const excerpt = assemble(list, ordered);

    return {
        excerpt,
        stats: {
            kept: excerpt.length,
            total: full.length,
            truncated: true,
            lines: ordered.length,
            totalLines: list.length,
            speakersCovered: new Set(ordered.map(i => speakerOf(segs[i])).filter(Boolean)).size,
            speakersTotal: new Set(segs.map(speakerOf).filter(Boolean)).size,
        },
    };
}

/**
 * The one place that knows which field carries a segment's speaker.
 * buildTranscriptArtifacts emits both `speaker` and `speakerId`; applySpeakerNames
 * rewrites only `speaker`. Reading the wrong one silently yields nothing.
 */
function speakerOf(seg) {
    return seg ? (seg.speaker || seg.speakerId || null) : null;
}

/** Speaker IDs ordered by how little they say, each mapped to its longest turn. */
function rarestFirst(segments, keep) {
    const byId = new Map();
    segments.forEach((seg, index) => {
        const id = speakerOf(seg);
        if (!id) return;
        const len = (seg.text || '').length;
        const cur = byId.get(id);
        if (!cur) byId.set(id, { count: 1, index, best: len });
        else {
            cur.count++;
            if (len > cur.best) { cur.best = len; cur.index = index; }
        }
    });
    return [...byId.values()]
        .filter(v => !keep.has(v.index))
        .sort((a, b) => a.count - b.count);
}

/** Fill remaining budget with windows anchored across the whole meeting. */
function spread(lines, add, windowLines, remaining) {
    if (remaining() <= 0 || !lines.length) return;
    const avgChars = Math.max(1, Math.round(
        lines.reduce((n, l) => n + l.length + 1, 0) / lines.length
    ));
    const windows = Math.max(1, Math.floor(remaining() / (avgChars * windowLines)));

    // Anchors span 0 .. lastPossible inclusive, so the first window opens at the
    // start and the last reaches the final turn. Midpoint-anchored strata leave
    // both ends uncovered — and a meeting's closing minutes carry the decisions.
    const lastPossible = Math.max(0, lines.length - windowLines);
    for (let w = 0; w < windows && remaining() > 0; w++) {
        const anchor = windows === 1 ? 0 : Math.round((lastPossible * w) / (windows - 1));
        for (let d = 0; d < windowLines; d++) {
            if (!add(anchor + d)) break;
        }
    }

    // Any budget still unspent (windows landing on already-kept lines) goes to
    // whatever fits, so we don't leave the model short for no reason.
    for (let i = 0; i < lines.length && remaining() > 0; i++) add(i);
}

/**
 * Join kept lines chronologically, marking every gap.
 *
 * The marker is not cosmetic: without it the model sees `[speaker_3] 12:05`
 * directly above `[speaker_9] 47:22` and may read them as consecutive turns.
 * That false adjacency is itself a cause of bad speaker merges.
 */
function assemble(lines, ordered) {
    const out = [];
    let prev = null;
    for (const i of ordered) {
        if (prev !== null && i !== prev + 1) out.push(GAP_MARKER);
        out.push(lines[i]);
        prev = i;
    }
    return out.join('\n');
}

module.exports = {
    renderTranscript,
    buildSpeakerNamingExcerpt,
    speakerOf,
    GAP_MARKER,
    DEFAULT_MAX_CHARS,
};
