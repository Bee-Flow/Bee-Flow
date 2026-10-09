/**
 * The loose argument grammar a model writes tool-call arguments in: plain
 * JSON (whole or cut at the length limit) and Gemma's fenced spelling.
 * `parseGemmaArgs(text)` gives a plain object or null and never throws.
 *
 * Platform code (utils/messageUtils.js repairs stored tool-call arguments with
 * it) as well as the leaked-tool-call recovery in core/llm/leakedToolCalls.js
 * use it, so it lives here, with no dependencies.
 */

'use strict';

// The string fence. The template spells it `<|"|>`; the transcripts of
// 2026-09-13 measured `<|">` — a model that has learnt the token from the
// template's rendering of its own tool grammar. Both are accepted, either
// may close a string the other opened.
const GEMMA_STRING = '<|">';
const GEMMA_STRING_TEMPLATE = '<|"|>';

// ─── The argument grammar ────────────────────────────────────────────────────
//
//   value    := string | object | array | number | 'true' | 'false' | 'null' | bareword
//   string   := FENCE … FENCE          FENCE = '<|"|>' (template) or '<|">' (measured);
//                                      verbatim inside — a quote, a newline or a
//                                      {{template}} in a value survives
//             | '"' json-string '"'    plain quotes the model sometimes writes
//   object   := '{' [pair (',' pair)*] [','] '}'
//   pair     := key ':' value          key := bareword | string
//   array    := '[' [value (',' value)*] [','] ']'
//   bareword := /[A-Za-z_$][\w$.\-]*/  → true/false/null are literals, anything
//                                      else is a STRING. `{mode:read}` was
//                                      refused as "a guess" until 2026-09-17,
//                                      when one live round carried four
//                                      app_update_component calls rejected as
//                                      unparsable for exactly that spelling —
//                                      the unquoted word IS the value the model
//                                      meant, and the tool's schema validates it.
//   number   := /-?\d+(\.\d+)?([eE][+-]?\d+)?/
//
// Plain JSON is a subset of this grammar, so the same parser is the loose
// fallback for a tool call whose JSON arguments did not parse (llmClient
// parseToolCallArgs, base.js flushToolCalls).
//
// A CUT tail — the text ends inside an open object or array — is closed in
// stack order ONLY when the last token consumed was a closer (`}` / `]`),
// optionally followed by a comma: every element written so far is then
// complete, and closing the containers loses nothing that was on the wire.
// Cut anywhere else (inside a string or fence, after a key, after a scalar)
// is null: a scalar may itself be truncated (`{limit:1` could be 10), and a
// binding cut after `{kind:"static"` has lost the very key that gives it
// meaning — actionNormalise relies on that null to refuse the call rather
// than write a half binding. Text after the first complete root value is
// ignored (a close token, prose, the next call). Containers nested past
// MAX_DEPTH are null too, whole or cut — see the constant for why.

const BAREWORD_RE = /[A-Za-z_$][\w$.\-]*/y;
const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = { true: true, false: false, null: null };

// Containers nested deeper than this are not an argument object — they are a
// small model in a repetition loop writing `[[[[…` until the length limit.
// The parser recurses two frames per level, so without a ceiling V8 answers
// such a tail with a RangeError instead of the LooseParseError every caller
// catches (measured 2026-09-18: `{"steps":` + 6,000 × `[`, cut at
// finish_reason 'length', escaped base.js flushToolCalls and REJECTED the
// whole stream — no tool_use_invalid, no done — and 500'd chatForcedTool
// where the composer expected compose_truncated). The exact overflow point
// depends on how much stack the caller already spent, so the ceiling is a
// count, not a catch: no real call nests within a hundred of it.
const MAX_DEPTH = 256;

class LooseParseError extends Error {}

/**
 * Parse one value of the grammar above starting at `start`. Returns the value
 * and the index just past it; throws LooseParseError when the text does not
 * fit the grammar, including a cut that cannot be closed.
 */
function parseLooseValueAt(text, start) {
    let i = start;
    const n = text.length;
    // True right after a `}` or `]` (a comma keeps it) — the only state in
    // which running out of text is closable. See the note above.
    let lastWasCloser = false;
    // Open containers at this point; see MAX_DEPTH.
    let depth = 0;

    const fail = (why) => { throw new LooseParseError(why); };
    const skipWs = () => { while (i < n && text[i].trim() === '') i++; };
    const fenceAt = (pos) => {
        if (text.startsWith(GEMMA_STRING_TEMPLATE, pos)) return GEMMA_STRING_TEMPLATE;
        if (text.startsWith(GEMMA_STRING, pos)) return GEMMA_STRING;
        return null;
    };

    const parseFenced = () => {
        const open = fenceAt(i);
        i += open.length;
        // Either spelling closes; the nearer one wins.
        const a = text.indexOf(GEMMA_STRING_TEMPLATE, i);
        const b = text.indexOf(GEMMA_STRING, i);
        const candidates = [a, b].filter(x => x !== -1);
        if (!candidates.length) fail('unclosed fence');
        const end = Math.min(...candidates);
        const value = text.slice(i, end);
        i = end + (text.startsWith(GEMMA_STRING_TEMPLATE, end) ? GEMMA_STRING_TEMPLATE.length : GEMMA_STRING.length);
        lastWasCloser = false;
        return value;
    };

    const parseQuoted = () => {
        i++; // opening quote
        const from = i;
        while (i < n && text[i] !== '"') {
            if (text[i] === '\\') i++;
            i++;
        }
        if (i >= n) fail('unterminated string');
        const inner = text.slice(from, i);
        i++; // closing quote
        lastWasCloser = false;
        try {
            return JSON.parse(`"${inner}"`);
        } catch (_) {
            // A raw newline or an escape JSON does not know: keep the text,
            // undo the two escapes the model uses.
            return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
    };

    const parseBareword = () => {
        BAREWORD_RE.lastIndex = i;
        const m = BAREWORD_RE.exec(text);
        if (!m) fail('expected a value');
        i += m[0].length;
        lastWasCloser = false;
        return m[0];
    };

    const parseNumber = () => {
        NUMBER_RE.lastIndex = i;
        const m = NUMBER_RE.exec(text);
        if (!m) fail('expected a number');
        i += m[0].length;
        lastWasCloser = false;
        return Number(m[0]);
    };

    const parseKey = () => {
        if (i >= n) fail('cut before a key');
        const ch = text[i];
        if (ch === '"') return parseQuoted();
        if (fenceAt(i)) return parseFenced();
        return parseBareword();
    };

    // Ran out of text inside `container`: closable, or not.
    const cut = (container) => {
        if (!lastWasCloser) fail('cut tail');
        return container;
    };

    const parseObject = () => {
        i++; // '{'
        lastWasCloser = false;
        const obj = {};
        for (;;) {
            skipWs();
            if (i >= n) return cut(obj);
            if (text[i] === '}') { i++; lastWasCloser = true; return obj; }
            const key = parseKey();
            skipWs();
            if (i >= n || text[i] !== ':') fail('expected ":"');
            i++;
            lastWasCloser = false;
            skipWs();
            if (i >= n) fail('cut after a key');
            obj[key] = parseValue();
            skipWs();
            if (i >= n) return cut(obj);
            if (text[i] === ',') { i++; continue; }
            if (text[i] === '}') { i++; lastWasCloser = true; return obj; }
            fail('expected "," or "}"');
        }
    };

    const parseArray = () => {
        i++; // '['
        lastWasCloser = false;
        const arr = [];
        for (;;) {
            skipWs();
            if (i >= n) return cut(arr);
            if (text[i] === ']') { i++; lastWasCloser = true; return arr; }
            arr.push(parseValue());
            skipWs();
            if (i >= n) return cut(arr);
            if (text[i] === ',') { i++; continue; }
            if (text[i] === ']') { i++; lastWasCloser = true; return arr; }
            fail('expected "," or "]"');
        }
    };

    const parseValue = () => {
        skipWs();
        if (i >= n) fail('cut before a value');
        const ch = text[i];
        if (ch === '{' || ch === '[') {
            // Counted here, once for both container kinds. A throw below
            // abandons the whole parse, so the count is not restored on it.
            if (++depth > MAX_DEPTH) fail('nested too deep');
            const value = ch === '{' ? parseObject() : parseArray();
            depth--;
            return value;
        }
        if (ch === '"') return parseQuoted();
        if (fenceAt(i)) return parseFenced();
        if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
        const word = parseBareword();
        return Object.prototype.hasOwnProperty.call(LITERALS, word) ? LITERALS[word] : word;
    };

    const value = parseValue();
    return { value, end: i };
}

/**
 * `{…}` in Gemma's argument syntax (or plain JSON, cut or whole) → a plain
 * object, or null when it does not parse. Parsing starts at the first `{`
 * and stops after the first complete object; see the grammar note above for
 * what a cut tail yields. Empty input is an empty argument object.
 */
function parseGemmaArgs(src) {
    const raw = String(src == null ? '' : src).trim();
    if (!raw) return {};
    const start = raw.indexOf('{');
    if (start === -1) return null;
    let value;
    try {
        ({ value } = parseLooseValueAt(raw, start));
    } catch (e) {
        // LooseParseError is the grammar saying no. A RangeError is the
        // stack saying no: MAX_DEPTH keeps the parser's own recursion far
        // from it, but the caller's stack is not ours to count, and every
        // caller (parseToolCallArgs, extractForcedResult, flushToolCalls)
        // promises never to throw. Both read as "does not parse".
        if (e instanceof LooseParseError || e instanceof RangeError) return null;
        throw e;
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

module.exports = { GEMMA_STRING, GEMMA_STRING_TEMPLATE, parseLooseValueAt, parseGemmaArgs };
