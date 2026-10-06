/**
 * Builder tools — reading a value path the AI wrote.
 *
 * The run reads paths with ONE grammar (shared/expr/path.mjs): `.name`,
 * `[0]`, `[-1]`, `[*]`, `["any key"]` and `[name="Subject"]`. A model writes
 * paths in a few other dialects too, and the builder used to "fix" them with
 * regexes that turned every bracket into a dot and then cut the path at the
 * first character outside [A-Za-z0-9_.$]. That destroyed every valid path
 * with an index, a wildcard or a quoted key (`value[0].from` became
 * `value.0.from`, `fields["Story Points"]` became `fields.Story`,
 * `order["price-with-tax"]` became `order.price`, a DIFFERENT field), and
 * builder_update_step applied it to the user's own untouched mappings.
 *
 * So the rule here is the opposite: a path the run can read is kept, only
 * respelled canonically (canonicalPath: `.0` → `[0]`, `['k']` → `["k"]`).
 * Only what the run cannot read is touched, each in the smallest way:
 *   $steps.x.output.y          → steps.x.output.y      (leading $ / dots)
 *   steps . x . output         → steps.x.output        (stray whitespace)
 *   steps[x].output[y]         → steps.x.output.y      (bare names in brackets)
 *   fields.Story Points        → fields["Story Points"] (a key with spaces)
 *   loop.x.output.a\"}}}},tempId: → loop.x.output.a   (JSON debris, trimmed
 *                                 after the LONGEST valid prefix — the
 *                                 Gemma-4 signature, findings F1 2026-09-17)
 *
 * Pure; required by bindings.js, outputFields.js, refCheck.js and the
 * data_extraction builder, so they all read one spelling.
 */

'use strict';

const { readPath, parsePath, formatPath, scanTemplate } = require('../expr');

// A dotted name character as the shared grammar reads it.
const NAME_CHAR_RE = /[\p{L}\p{N}\p{M}_$@-]/u;
// Words a person might put in a key with spaces: "Story Points", "Total (EUR)",
// "Q&A". Never JSON punctuation, quotes, brackets, operators or a dot, so the
// Gemma tail (`\"}}}},tempId:`) and an expression (`total + 1`) never merge.
const SPACED_WORDS_RE = /^([ \t]+[\p{L}\p{N}\p{M}_$@\-&/()#%]+)+/u;

/**
 * Remove whitespace around dots that sit outside quotes and collapse a run of
 * them: `steps . x` / `steps..x` → `steps.x`. A dot inside a quoted key or a
 * match value is data (`["Total.."]`, `[name="v1..2"]`) and is kept.
 */
function squeezeDots(s) {
    let out = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += s[i + 1] || ''; i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        if (c === '.') {
            out = out.replace(/[ \t]+$/, '');
            // `out` only ends in a dot here when that dot was unquoted too: a
            // quoted key always closes with a quote and `]` before the next.
            if (!out.endsWith('.')) out += '.';
            while (s[i + 1] === ' ' || s[i + 1] === '\t') i++;
            continue;
        }
        out += c;
    }
    return out;
}

/**
 * `steps[x].output[y]` → `steps.x.output.y`: a bare name in brackets is not a
 * path (only `[0]`, `[*]`, `["k"]` and `[k=v]` are), and weaker models write
 * it. Indices, wildcards, quoted keys and match segments are left alone.
 */
function unbracketBareNames(s) {
    let out = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += s[i + 1] || ''; i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        if (c === '[') {
            const m = /^\[[ \t]*([\p{L}_$@][\p{L}\p{N}\p{M}_$@-]*)[ \t]*\]/u.exec(s.slice(i));
            if (m) {
                out += (out ? '.' : '') + m[1];
                i += m[0].length - 1;
                continue;
            }
        }
        out += c;
    }
    return out;
}

/**
 * Normalise one path the AI wrote.
 *
 * Returns { path, tokens, debris, notes }:
 *   path    the canonical path (or the cleaned input when nothing parses)
 *   tokens  the parsed tokens, or null when not even a head name is there
 *   debris  the text trimmed off the end, or null
 *   notes   what was rewritten that the model should learn (`.0` → `[0]`,
 *           a key with spaces); cosmetic fixes ($, whitespace, `["k"]` →
 *           `.k`) stay silent, as they always were
 *
 * `trimDebris: false` (templates) leaves a path that does not parse whole
 * as it was: a placeholder holding an expression is the template check's
 * business, not something to cut down to its first name.
 */
function normalizeAiPath(raw, { trimDebris = true } = {}) {
    if (typeof raw !== 'string') return { path: raw, tokens: null, debris: null, notes: [] };
    const notes = [];
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NAME_CHAR_RE is one character class tested on a single character (s[i - 1]), and /^\$+/ and /^\.+/ are anchored single repeats: linear
    let s = raw.trim().replace(/^\$+/, '').replace(/^\.+/, '');
    s = unbracketBareNames(squeezeDots(s));
    let tokens = parsePath(s);
    let debris = null;
    if (!tokens) {
        const r = readPath(s, 0);
        if (!r) return { path: s, tokens: null, debris: null, notes };
        tokens = r.tokens;
        let i = r.end;
        // A key with spaces, written without quotes: merge the words into the
        // last dotted name, then keep reading the path after them.
        while (i < s.length) {
            const last = tokens[tokens.length - 1];
            const m = SPACED_WORDS_RE.exec(s.slice(i));
            if (!m || last.type !== 'prop' || typeof last.key !== 'string' || !NAME_CHAR_RE.test(s[i - 1] || '')) break;
            tokens[tokens.length - 1] = { type: 'prop', key: last.key + m[0] };
            notes.push(`a key with spaces is written ["${last.key + m[0]}"]`);
            i += m[0].length;
            if (s[i] === '.' || s[i] === '[') {
                const more = readPath(`x${s.slice(i)}`, 0);
                if (more && more.tokens.length > 1) {
                    tokens.push(...more.tokens.slice(1));
                    i += more.end - 1;
                }
            }
        }
        const rest = s.slice(i);
        if (rest.trim()) {
            if (!trimDebris) return { path: s, tokens: null, debris: null, notes: [] };
            debris = rest;
        }
    }
    // `.0` reads as key "0" (which an index also resolves), but `[0]` is the
    // spelling the prompt teaches and the editor writes — said once.
    if (/\.[0-9]+(?=$|[.[])/.test(s.split(/["']/)[0])) notes.push('a list index is written [0], not .0');
    return { path: formatPath(tokens), tokens, debris, notes };
}

/** The canonical spelling of a path, or the input unchanged when it does not parse. */
function canonicalAiPath(raw) {
    const n = normalizeAiPath(raw, { trimDebris: false });
    return n.tokens ? n.path : raw;
}

/** Does a string hold at least one `{{ … }}` placeholder (quote-aware)? */
function hasPlaceholder(text) {
    return typeof text === 'string' && scanTemplate(text).some(p => p.type === 'ref');
}

/** The trimmed inner text of every `{{ … }}` placeholder (quote-aware). */
function placeholdersOf(text) {
    return typeof text === 'string' ? scanTemplate(text).filter(p => p.type === 'ref').map(p => p.inner) : [];
}

module.exports = { normalizeAiPath, canonicalAiPath, hasPlaceholder, placeholdersOf };
