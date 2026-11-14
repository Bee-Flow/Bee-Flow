// @typecheck strict
/**
 * Reading a tool argument while its JSON is still streaming in.
 */

'use strict';

/** The escapes that stand for another character; every other escaped character stands for itself. */
const CONTROL_ESCAPES = new Map([['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f']]);

/**
 * Extract a (possibly unterminated) JSON string field from a partial JSON
 * fragment that is still streaming in. Used to live-stream a tool argument
 * (e.g. notebook_write's `content`) before the full tool call is complete.
 * Returns the decoded string value, or null if the field hasn't started yet.
 * @param {string} partial
 * @param {string} field
 */
function extractPartialJsonString(partial, field) {
    if (typeof partial !== 'string') return null;
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the field is an argument name the caller writes as a literal
    const keyRe = new RegExp(`"${field}"\\s*:\\s*"`);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a literal key and two whitespace runs with a colon between them: linear
    const m = keyRe.exec(partial);
    if (!m) return null;
    let out = '';
    for (let i = m.index + m[0].length; i < partial.length; i++) {
        const c = partial[i];
        if (c === '\\') {
            const next = partial[i + 1];
            if (next === undefined) break;            // incomplete escape at the tail
            if (next === 'u') {
                const hex = partial.slice(i + 2, i + 6);
                if (hex.length < 4) break;            // incomplete \uXXXX at the tail
                out += String.fromCharCode(parseInt(hex, 16));
                i += 4;
            } else out += CONTROL_ESCAPES.get(next) ?? next;   // \" \\ \/ and anything else stand for themselves
            i += 1;                                    // skip the escaped char
        } else if (c === '"') {
            break;                                     // closing quote → string complete
        } else {
            out += c;
        }
    }
    return out;
}

module.exports = { extractPartialJsonString };
