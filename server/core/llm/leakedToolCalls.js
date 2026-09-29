// @typecheck
/**
 * Tool calls a model wrote as TEXT instead of calling.
 *
 * Measured 2026-09-13 (App Studio builder, Gemma 4 26B-A4B on llama.cpp, Fast
 * tier, thinking off): after three good rounds the model put its fourth call —
 * `app_upsert_table` for a suppliers table — INSIDE the thought channel, in its
 * own wire format:
 *
 *   <|tool_call>call:app_upsert_table{fields:[{key:<|">name<|">,type:<|">text<|">},…],name:<|">suppliers<|">}<tool_call|>
 *
 * The runtime's parser only reads that syntax outside the channel, so the
 * round came back as reasoning text, no content, no tool call, stop='stop' —
 * indistinguishable from "the model is done". The loop ended the turn in
 * silence: an empty canvas, a plan at 0/5 and a Thought block full of tokens.
 *
 * The call is right there and its grammar is small, so the server parses it
 * (doctrine: a rejection the server could have repaired deterministically is
 * a server bug). Three shapes are recognised, in every text the round produced:
 *   - Gemma 4:        <|tool_call>call:NAME{ARGS}<tool_call|> — keys bare or
 *                     fenced, strings fenced by the <|"> token, nesting as JSON;
 *   - Hermes / Qwen:  <tool_call>{"name":NAME,"arguments":{…}}</tool_call>;
 *   - a reply that IS one JSON object {"name":NAME,"arguments":{…}}.
 * Only names on the round's tool menu count — anything else is reported back
 * so the loop can nudge the model with the specific mistake instead of
 * guessing at an alias.
 *
 * Pure: no provider, no route. core/llm requires nothing outside core.
 */

'use strict';
const log = require('../../telemetry/log');

const GEMMA_OPEN = '<|tool_call>';
const GEMMA_CLOSE = '<tool_call|>';
// The string fence. The template spells it `<|"|>`; the transcripts of
// 2026-09-13 measured `<|">` — a model that has learnt the token from the
// template's rendering of its own tool grammar. Both are accepted, either
// may close a string the other opened.
const GEMMA_STRING = '<|">';
const GEMMA_STRING_TEMPLATE = '<|"|>';
const HERMES_OPEN = '<tool_call>';
const HERMES_CLOSE = '</tool_call>';

const TOOL_NAME_RE = /^[A-Za-z_][\w.\-]*$/;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GEMMA_RE = new RegExp(
    `${escapeRe(GEMMA_OPEN)}\\s*call:\\s*([A-Za-z_][\\w.\\-]*)\\s*([\\s\\S]*?)${escapeRe(GEMMA_CLOSE)}`,
    'g',
);
// An open without its close: the model stopped (or was cut) before the end
// token. Greedy to the end of the text; the parser reads the first complete
// object and ignores whatever prose follows it.
const GEMMA_OPEN_TAIL_RE = new RegExp(
    `${escapeRe(GEMMA_OPEN)}\\s*call:\\s*([A-Za-z_][\\w.\\-]*)\\s*([\\s\\S]*)$`,
);
const HERMES_RE = new RegExp(`${escapeRe(HERMES_OPEN)}\\s*([\\s\\S]*?)\\s*${escapeRe(HERMES_CLOSE)}`, 'g');

/** Does the text carry any of the recognised wire syntaxes at all? */
function hasLeakedToolCallSyntax(text) {
    const s = typeof text === 'string' ? text : '';
    return s.includes(GEMMA_OPEN) || s.includes(HERMES_OPEN);
}

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
    const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };
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

function parseHermesCall(inner) {
    let value;
    try { value = JSON.parse(inner); } catch (_) { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!TOOL_NAME_RE.test(name)) return null;
    let args = value.arguments !== undefined ? value.arguments
        : value.parameters !== undefined ? value.parameters
            : value.input !== undefined ? value.input : {};
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (_) { return null; }
    }
    if (args === null || args === undefined) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) return null;
    return { name, args };
}

/**
 * Every tool call written out in `text`, in order, plus the text with those
 * spans removed. A call whose name is not in `toolNames` (a Set; omit to
 * accept any) or whose arguments do not parse lands in `rejected` with the
 * reason, never in `calls`.
 * @param {any} text
 * @param {{ toolNames?: Set<string> }} [opts]
 * @returns {{ calls: Array<{name:string,args:object,raw:string,format:string}>,
 *             rejected: Array<{name:string|null,reason:'unknown_tool'|'unparsable',raw:string,format:string}>,
 *             text: string }}
 */
function extractLeakedToolCalls(text, { toolNames } = {}) {
    const src = typeof text === 'string' ? text : '';
    const calls = [];
    const rejected = [];
    if (!src) return { calls, rejected, text: '' };
    const known = toolNames instanceof Set ? toolNames : null;

    const accept = (name, args, raw, format) => {
        if (known && !known.has(name)) { rejected.push({ name, reason: 'unknown_tool', raw, format }); return; }
        if (!args) { rejected.push({ name, reason: 'unparsable', raw, format }); return; }
        calls.push({ name, args, raw, format });
    };

    let rest = src.replace(GEMMA_RE, (raw, name, argSrc) => {
        accept(name, parseGemmaArgs(argSrc), raw, 'gemma');
        return '\n';
    });
    const tail = GEMMA_OPEN_TAIL_RE.exec(rest);
    if (tail) {
        accept(tail[1], parseGemmaArgs(tail[2]), tail[0], 'gemma');
        rest = rest.slice(0, tail.index);
    }
    rest = rest.replace(HERMES_RE, (raw, inner) => {
        const parsed = parseHermesCall(inner);
        if (parsed) accept(parsed.name, parsed.args, raw, 'hermes');
        else rejected.push({ name: null, reason: 'unparsable', raw, format: 'hermes' });
        return '\n';
    });

    // A reply that is nothing but one call object.
    if (!calls.length && !rejected.length) {
        const bare = rest.trim();
        if (bare.startsWith('{') && bare.endsWith('}')) {
            const parsed = parseHermesCall(bare);
            if (parsed) { accept(parsed.name, parsed.args, bare, 'json'); rest = ''; }
        }
    }

    return { calls, rejected, text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * The tool-loop entry point: given a round's assembled response
 * (`{ content, thinkingParts }` as builderShared.streamWithRetry returns it),
 * find calls written as text in the content and in every UNSIGNED thinking
 * part (signed thinking is Anthropic's and never carries them), and hand them
 * back in the `toolCalls` shape the loop already consumes. Recovered calls
 * carry `_recovered: true` so the loop can tell the model what happened in the
 * tool result.
 *
 * @param {any} response
 * @param {{ toolNames?: Set<string>, iter?: number }} [opts]
 * @returns {{ toolCalls: Array, rejected: Array, content: string|null, sources: string[] }}
 *   `content` is the round's content with recovered spans removed (null when
 *   nothing is left); `sources` names where calls were found ('content',
 *   'thinking').
 */
function recoverLeakedToolCalls(response, { toolNames, iter = 0 } = {}) {
    const out = { toolCalls: [], rejected: [], content: (response && response.content) || null, sources: [] };
    if (!response || typeof response !== 'object') return out;

    const collect = (text, source) => {
        if (!hasLeakedToolCallSyntax(text) && !(source === 'content' && String(text || '').trim().startsWith('{'))) {
            return text;
        }
        const found = extractLeakedToolCalls(text, { toolNames });
        for (const call of found.calls) {
            out.toolCalls.push({
                id: `leak_${iter}_${out.toolCalls.length}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
                _recovered: true,
                _recoveredFrom: source,
            });
        }
        for (const r of found.rejected) {
            out.rejected.push({ ...r, source });
            // The raw span is the fixture the next parser fix is built from —
            // a rejection that only said "unparsable" cost a live run to
            // reproduce. 300 chars: enough to see the shape, never a whole batch.
            log.warn(`[leakedToolCalls] rejected ${r.name || '?'}:${r.reason} in ${source} (${r.format}): ${String(r.raw || '').slice(0, 300)}`);
        }
        if ((found.calls.length || found.rejected.length) && !out.sources.includes(source)) out.sources.push(source);
        return found.text;
    };

    if (typeof response.content === 'string' && response.content) {
        const stripped = collect(response.content, 'content');
        out.content = stripped && stripped.trim() ? stripped : null;
    }
    for (const part of Array.isArray(response.thinkingParts) ? response.thinkingParts : []) {
        if (!part || part.signature || part.redacted || typeof part.text !== 'string') continue;
        collect(part.text, 'thinking');
    }
    return out;
}

// What the model reads back on a call it never actually made: the same
// words in both builders, so a fix to the wording lands in both. Deliberately
// WITHOUT the literal markers: llama-server tokenises message text with
// special tokens enabled, so a `<|tool_call>` spelled out in a tool result
// would reach the model as the real control token, mid-transcript.
const RECOVERED_CALL_HINT = 'This call was written as TEXT inside your reasoning, not made through the function-calling interface. The server executed it this time; from now on call tools ONLY as function calls — never spell out tool-call markup in your reasoning or your answer.';

// What the model reads back on a call whose arguments were not valid JSON on
// the wire and were closed by the loose parser (base.js flushToolCalls emits
// `_repaired: true`). The typical cause is a batch cut at the length limit:
// every entry that was complete on the wire was applied, nothing after the
// cut exists. Said in the result, in both builders, so the model continues
// from the last landed entry instead of resending the whole batch — or
// worse, assuming the tail landed. Same rule as above: no control tokens.
const REPAIRED_CALL_HINT = 'The arguments of this call were cut off (not valid JSON on the wire — usually the length limit) and the server closed them after the last complete entry. Only those entries were applied; nothing after the cut exists. Continue from there in a NEW call — do not resend the entries that landed — and keep each call small enough to finish.';

module.exports = {
    GEMMA_OPEN,
    GEMMA_CLOSE,
    GEMMA_STRING,
    GEMMA_STRING_TEMPLATE,
    HERMES_OPEN,
    HERMES_CLOSE,
    RECOVERED_CALL_HINT,
    REPAIRED_CALL_HINT,
    hasLeakedToolCallSyntax,
    parseGemmaArgs,
    parseLooseValueAt,
    extractLeakedToolCalls,
    recoverLeakedToolCalls,
};
