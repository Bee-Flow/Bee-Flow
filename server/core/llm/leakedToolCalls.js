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
// The string fences and the argument grammar live in shared/looseToolArgs.js:
// platform code parses tool-call arguments with them too.
const { GEMMA_STRING, GEMMA_STRING_TEMPLATE, parseLooseValueAt, parseGemmaArgs } = require('../../shared/looseToolArgs');
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
