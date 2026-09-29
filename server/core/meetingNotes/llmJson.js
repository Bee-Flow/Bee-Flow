// @typecheck
/**
 * Tolerant JSON extraction from LLM replies — pure, no deps.
 *
 * These prompts ask for "ONLY a JSON object/array". Two things routinely break
 * that: the model wraps the JSON in prose or a ```json fence, and — the
 * expensive one — the reply hits the output-token ceiling and stops mid-value.
 *
 * A strict JSON.parse turns the second case into total loss: the caller
 * catches, returns null/[], and a 100-minute meeting silently yields no
 * speaker names or no action items at all. Recovering N-1 of N items is
 * enormously better than recovering none, so on a parse failure we trim back
 * to the last complete element and close the structure ourselves.
 */

/**
 * Parse a JSON array from an LLM reply, salvaging a truncated tail.
 *
 * @param {string} content Raw model reply.
 * @returns {{ value: Array, salvaged: boolean }|null} null when nothing usable.
 */
function parseJsonArray(content) {
    const slice = sliceBetween(content, '[', ']');
    if (slice !== null) {
        const direct = tryParse(slice);
        if (Array.isArray(direct)) return { value: direct, salvaged: false };
    }

    // Truncated: there may be no closing ']' at all. Work from the opening
    // bracket and cut back to the last element boundary we know is complete.
    const start = String(content || '').indexOf('[');
    if (start === -1) return null;

    const body = String(content).slice(start);
    for (const end of elementBoundaries(body, '}')) {
        const salvaged = tryParse(`${body.slice(0, end + 1)}]`);
        if (Array.isArray(salvaged) && salvaged.length) {
            return { value: salvaged, salvaged: true };
        }
    }
    return null;
}

/**
 * Parse a JSON object from an LLM reply, salvaging a truncated tail.
 *
 * @param {string} content Raw model reply.
 * @returns {{ value: object, salvaged: boolean }|null} null when nothing usable.
 */
function parseJsonObject(content) {
    const slice = sliceBetween(content, '{', '}');
    if (slice !== null) {
        const direct = tryParse(slice);
        if (isPlainObject(direct)) return { value: direct, salvaged: false };
    }

    const start = String(content || '').indexOf('{');
    if (start === -1) return null;

    const body = String(content).slice(start);
    // A flat {"speaker_1":"Tom", ...} map truncates mid-pair; cut back to the
    // last complete pair, which always ends at a closing quote before a comma.
    for (const end of pairBoundaries(body)) {
        const salvaged = tryParse(`${body.slice(0, end + 1)}}`);
        if (isPlainObject(salvaged) && Object.keys(salvaged).length) {
            return { value: salvaged, salvaged: true };
        }
    }
    return null;
}

/** Text between the first `open` and the last `close`, or null. */
function sliceBetween(content, open, close) {
    const text = String(content || '');
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start === -1 || end <= start) return null;
    return text.slice(start, end + 1);
}

function tryParse(text) {
    try { return JSON.parse(text); } catch (_) { return undefined; }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Candidate cut points for an array of objects, last-complete-first.
 * Yields indices of `closer` characters, scanning backwards.
 */
function* elementBoundaries(body, closer) {
    for (let i = body.length - 1; i >= 0; i--) {
        if (body[i] === closer) yield i;
    }
}

/**
 * Candidate cut points for a flat object map, last-complete-first: the closing
 * quote of a string value, or a digit/keyword end, immediately before a comma.
 */
function* pairBoundaries(body) {
    for (let i = body.length - 1; i >= 0; i--) {
        if (body[i] !== ',') continue;
        // Cut just before the comma; JSON.parse validates the rest.
        yield i - 1;
    }
}

module.exports = { parseJsonArray, parseJsonObject };
