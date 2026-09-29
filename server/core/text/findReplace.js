/**
 * Find-and-replace over a text slot, for tools an LLM drives.
 *
 * Extracted verbatim from integrations/webpageDocTools.js when Documents needed
 * the same thing. Editing a slot by substring rather than rewriting it whole is
 * not a nicety: a full rewrite costs the whole file in output tokens every time,
 * and — the part that actually bites — it silently discards whatever the human
 * changed by hand since the model last read it. Documents make that worse than
 * webpages ever did, because a document is something people hand-edit WHILE the
 * assistant is working on it.
 *
 * THE MATCHING LADDER, in order, and each rung earns its place:
 *
 *   1. Verbatim, exactly one hit          → replace it.
 *   2. Verbatim, several hits             → REFUSE, listing the line numbers,
 *                                           unless the caller said replaceAll.
 *                                           Guessing which one was meant is how
 *                                           you change the wrong invoice line.
 *   3. Whitespace-normalised, one hit     → replace it. A model that copied a
 *                                           snippet out of a previous message
 *                                           has usually collapsed the newlines,
 *                                           and failing on that is a retry loop
 *                                           with no new information in it.
 *   4. Nothing                            → a diff-style hint showing the
 *                                           nearest thing, so the retry has
 *                                           something to go on.
 *
 * Every function here is pure: text in, text out, no I/O and no opinion about
 * what the slot is called. The caller supplies the vocabulary (`label`,
 * `readHint`) so the same engine can say "index.html" to one tool and "the
 * document body" to another.
 */

/** Replace `str[start..end)` with `insert`. */
function spliceAt(str, start, end, insert) {
    return str.slice(0, start) + insert + str.slice(end);
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function normalizeWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Find every occurrence of `needle` in `haystack`. Returns an array of
 * `{ start, end, line }`. Empty needle returns []. Overlap is not supported —
 * advances by needle.length after each hit.
 */
function findAllOccurrences(haystack, needle) {
    const out = [];
    if (!needle) return out;
    let i = 0;
    while (true) {
        const idx = haystack.indexOf(needle, i);
        if (idx < 0) break;
        out.push({ start: idx, end: idx + needle.length, line: lineNumberForOffset(haystack, idx) });
        i = idx + needle.length;
    }
    return out;
}

function lineNumberForOffset(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) line++;
    }
    return line;
}

/**
 * Locate the byte-range in `original` whose normalized form matches the
 * normalized form of `needle`. Returns { start, end } or null.
 *
 * Used as a fallback when the snippet exists in the file modulo whitespace
 * differences (e.g. the model passed copy-pasted text with collapsed
 * whitespace, but the file has the same characters separated by newlines).
 */
function locateOriginalRange(original, needle) {
    const normNeedle = normalizeWhitespace(needle);
    if (!normNeedle) return null;

    let normalized = '';
    const idxMap = []; // normalized-position → original-position
    let lastWasSpace = false;
    for (let i = 0; i < original.length; i++) {
        const c = original[i];
        if (/\s/.test(c)) {
            if (!lastWasSpace && normalized.length > 0) {
                normalized += ' ';
                idxMap.push(i);
                lastWasSpace = true;
            }
        } else {
            normalized += c;
            idxMap.push(i);
            lastWasSpace = false;
        }
    }
    const trimmedStart = normalized.match(/^\s*/)[0].length;
    normalized = normalized.trim();

    const hit = normalized.indexOf(normNeedle);
    if (hit < 0) return null;

    const startNorm = hit + trimmedStart;
    const endNorm = startNorm + normNeedle.length;
    if (endNorm > idxMap.length) return null;
    const startOrig = idxMap[startNorm];
    const endOrig = endNorm < idxMap.length ? idxMap[endNorm] : original.length;
    return { start: startOrig, end: endOrig };
}

/**
 * When the snippet doesn't match, surface a short diff-style hint so the model
 * can retry with something better than the same string again.
 *
 * @param {string} current  the slot's text
 * @param {string} findText what the model looked for
 * @param {string} readHint what to tell it to call to see the real content
 */
function buildNearestMatchHint(current, findText, readHint) {
    const norm = normalizeWhitespace(findText);
    if (!norm) return ` ${readHint} first to see the exact current content, then retry.`;

    const words = norm.split(' ').filter(Boolean);
    if (words.length === 0) return '';

    const probe = words.slice(0, Math.min(4, words.length)).join(' ').toLowerCase();
    const lc = current.toLowerCase();
    const idx = lc.indexOf(probe);
    if (idx < 0) {
        return ` No similar snippet found. ${readHint} and copy the exact text into find_text.`;
    }

    // Build a 3-line diff-style preview around the nearest hit.
    const previewStart = Math.max(0, current.lastIndexOf('\n', idx) + 1);
    const previewEnd = current.indexOf('\n', idx + Math.min(160, findText.length));
    const realEnd = previewEnd < 0 ? Math.min(current.length, idx + 200) : previewEnd;
    const actualSlice = current.slice(previewStart, realEnd);
    const line = lineNumberForOffset(current, idx);

    return ` The closest match is at line ${line}. Whitespace likely differs. Diff:\n- ${truncate(findText.replace(/\n/g, '⏎'), 160)}\n+ ${truncate(actualSlice.replace(/\n/g, '⏎'), 160)}\nUse the "+" line verbatim as your next find_text.`;
}

/**
 * Run the whole ladder. Returns `{ content, message }` on success or
 * `{ error }` — never throws, because every one of these outcomes is something
 * the model should read and act on rather than a crash.
 *
 * @param {string} current            the slot's current text
 * @param {object} opts
 * @param {string} opts.findText
 * @param {string} [opts.replaceText]  '' deletes
 * @param {boolean} [opts.replaceAll]
 * @param {string} opts.label          what to call the slot in messages
 * @param {string} opts.readHint       e.g. 'Call document_read({ documentId })'
 */
function applyFindReplace(current, { findText, replaceText = '', replaceAll = false, label, readHint }) {
    if (!findText) return { error: 'find_text is required.' };
    if (!current) {
        return { error: `${label} is empty — there is nothing to replace. Write it first.` };
    }

    const occurrences = findAllOccurrences(current, findText);

    if (occurrences.length === 1) {
        return {
            content: spliceAt(current, occurrences[0].start, occurrences[0].end, replaceText),
            message: replaceText
                ? `${label} updated (1 replacement at line ${occurrences[0].line}).`
                : `${label}: text removed at line ${occurrences[0].line}.`,
        };
    }

    if (occurrences.length >= 2) {
        if (!replaceAll) {
            const lines = occurrences.map(o => o.line);
            return {
                error: `find_text matches ${occurrences.length} places in ${label} (lines ${lines.join(', ')}). `
                    + 'Either narrow find_text so it matches exactly once, or set replace_all: true to replace every occurrence.',
            };
        }
        // Walk back-to-front so byte offsets stay valid as we splice.
        let next = current;
        for (let i = occurrences.length - 1; i >= 0; i--) {
            next = spliceAt(next, occurrences[i].start, occurrences[i].end, replaceText);
        }
        return {
            content: next,
            message: `${label} updated (${occurrences.length} replacements, lines ${occurrences.map(o => o.line).join(', ')}).`,
        };
    }

    // Whitespace-normalised fallback. Single replacement only: the normalised
    // mapping is order-dependent, so replace_all here would be ambiguous.
    const range = locateOriginalRange(current, findText);
    if (range) {
        const line = lineNumberForOffset(current, range.start);
        return {
            content: spliceAt(current, range.start, range.end, replaceText),
            message: replaceText
                ? `${label} updated at line ${line} (whitespace-normalized match).`
                : `${label}: text removed at line ${line} (whitespace-normalized match).`,
        };
    }

    return {
        error: `Could not find the find_text snippet in ${label}.${buildNearestMatchHint(current, findText, readHint)}`,
    };
}

module.exports = {
    applyFindReplace,
    spliceAt,
    truncate,
    normalizeWhitespace,
    findAllOccurrences,
    lineNumberForOffset,
    locateOriginalRange,
    buildNearestMatchHint,
};
