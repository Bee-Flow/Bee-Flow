/**
 * Rescue JSON that a language model very nearly wrote correctly.
 *
 * A model asked for `{"markdown": "<a two-page document>"}` reliably produces a
 * structurally complete object whose string values contain LITERAL newlines —
 * because it is writing a document, and a document has lines in it. JSON does
 * not allow a raw control character inside a string, so `JSON.parse` throws on
 * something that is otherwise perfect, and the step fails with every field
 * intact but unreachable.
 *
 * That is the failure this module exists for. It is deliberately NOT a general
 * "fix any JSON" pass: guessing at genuinely broken structure is how a step
 * silently returns the wrong shape. Only four repairs, each one a thing models
 * do and none of which can change the MEANING of valid JSON:
 *
 *   1. Raw control characters inside a string → their escape (`\n`, `\t`, …).
 *   2. A trailing comma before `}` or `]`.
 *   3. A ```fence``` around the whole thing.
 *   4. Smart quotes used as JSON string delimiters is NOT repaired — that
 *      changes what the author wrote, and a model that emits “ for " has
 *      usually gone wrong in a way worth failing on.
 *
 * Truncation is out of scope on purpose. Closing a cut-off object would hand
 * the caller a document missing its last half while looking complete — the
 * caller must be able to tell those apart, so a truncated payload stays
 * unparseable and is reported as truncated.
 */

'use strict';

/** Strip a leading ```json / ``` fence and its closing fence, if both are there. */
function stripFence(text) {
    const t = String(text).trim();
    if (!t.startsWith('```')) return t;
    const withoutOpen = t.replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/, '');
    return withoutOpen.replace(/\r?\n?[ \t]*```$/, '').trim();
}

/**
 * Escape raw control characters that appear INSIDE string literals, and drop
 * trailing commas. Structure outside strings is left exactly as written.
 *
 * The scan tracks string state itself rather than using a regex, because the
 * only way to know whether a newline is "inside a string" is to have counted
 * the quotes before it — and to have honoured the backslash escapes, so that
 * a `\"` in the middle of a sentence does not read as the end of the string.
 */
function escapeControlChars(text) {
    let out = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\' && inString) { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }

        if (inString) {
            const code = ch.charCodeAt(0);
            if (code < 0x20) {
                // The three that carry meaning in a document get their short
                // escape; anything else becomes \uXXXX rather than being
                // dropped, because silently deleting a byte from someone's
                // text is worse than an ugly escape nobody will ever read.
                if (ch === '\n') out += '\\n';
                else if (ch === '\r') out += '\\r';
                else if (ch === '\t') out += '\\t';
                else out += `\\u${code.toString(16).padStart(4, '0')}`;
                continue;
            }
            out += ch;
            continue;
        }

        // Outside a string: drop a comma that is followed only by whitespace
        // and a closer.
        if (ch === ',') {
            const rest = text.slice(i + 1);
            const next = rest.match(/^\s*([}\]])/);
            if (next) continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Parse `text` as JSON, repairing the model-shaped malformations above if the
 * plain parse fails.
 *
 * Returns `{ ok, value, repaired }` — `repaired` says whether the rescue was
 * needed, so a caller can log that its model is producing malformed JSON
 * instead of never finding out.
 */
function parseJsonish(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, repaired: false };

    const direct = stripFence(text);
    try {
        return { ok: true, value: JSON.parse(direct), repaired: false };
    } catch (_) { /* fall through to the repair */ }

    try {
        return { ok: true, value: JSON.parse(escapeControlChars(direct)), repaired: true };
    } catch (_) {
        return { ok: false, repaired: false };
    }
}

module.exports = { parseJsonish, stripFence, escapeControlChars };
