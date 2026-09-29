// @typecheck
/**
 * The provider-agnostic mechanics every tool-calling build loop shares: what
 * a "cut off at max_tokens" stop looks like across adapters, the retry pairs
 * appended when a round produced no tool call (cut off, or simply empty — a
 * call written as text lives in core/llm/leakedToolCalls), the provider's own words for
 * an error bubble, token accounting over the adapters' shared 'done' payload,
 * and defensive tool-argument parsing.
 *
 * Both builders (routines: routes/ai/automationBuilder/chatTurnLoop.js; apps:
 * routes/ai/appStudioBuilder/turnLoop.js) bind their own note prefix and
 * parameterless-tool set onto these — the mechanics were byte-identical
 * copies before, and a fix landing in one loop did not reach the other.
 * core/llm requires nothing outside core.
 */

'use strict';

// Stop reasons that mean "the reply hit max_tokens", in every spelling the
// adapters' shared 'done' payload carries: OpenAI-compatible runtimes
// (llama.cpp, vLLM, Ollama) say 'length', Anthropic 'max_tokens', the OpenAI
// Responses API 'max_output_tokens', Google 'MAX_TOKENS'.
const TRUNCATION_STOP_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS']);

function isTruncatedStop(reason) {
    return typeof reason === 'string' && TRUNCATION_STOP_REASONS.has(reason);
}

// Shown in place of the model's text when a round was cut off before it said
// anything — an assistant message with EMPTY content is a 400 on Anthropic
// (claude.js normalizeContent) and rejected by Mistral, so the placeholder is
// never blank.
const TRUNCATION_PLACEHOLDER = '(reply cut off at the length limit before any tool call)';

/**
 * The [assistant, user] pair a loop appends when a round ran into max_tokens
 * without producing a tool call — on a thinking model that is reasoning that
 * never converged, and the next round runs with thinking off. The user note
 * carries `notePrefix` so the loop's history sanitiser drops it from
 * cross-turn history like its validation reports. Pure.
 *
 * @param {any} content
 * @param {any} thinkingForReplay
 * @param {{ notePrefix?: string }} [opts]
 */
function truncationRetryMessages(content, thinkingForReplay, { notePrefix } = {}) {
    const text = typeof content === 'string' && content.trim() ? content : TRUNCATION_PLACEHOLDER;
    const assistant = {
        role: 'assistant',
        content: text,
        ...(Array.isArray(thinkingForReplay) && thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
    };
    const note = 'Your previous reply hit the length limit before it contained a tool call, so nothing was applied. Answer now with the tool call directly — no deliberation, no prose first.';
    const user = { role: 'user', content: notePrefix ? `${notePrefix}\n${note}` : note };
    return [assistant, user];
}

// Shown in place of the model's text when a round produced nothing at all —
// same reason as TRUNCATION_PLACEHOLDER: an empty assistant message is a 400
// on Anthropic and rejected by Mistral.
const EMPTY_REPLY_PLACEHOLDER = '(reply contained neither a tool call nor a message)';

/**
 * A reply with nothing in it for the person: empty, or only punctuation and
 * whitespace (the local model ended two playbook turns with a bare "." —
 * measured 2026-09-13). Such a round is not "done".
 */
function isBlankReply(content) {
    if (typeof content !== 'string') return true;
    const t = content.trim();
    if (!t) return true;
    return t.length <= 8 && !/[\p{L}\p{N}]/u.test(t);
}

/**
 * The [assistant, user] pair a loop appends when a round ended with NO tool
 * call and NO text (stop reason 'stop', so not a cut-off). Measured on Gemma 4
 * 2026-09-13: the model wrote its next call as text inside its thought
 * channel and the loop read the empty round as "done". When
 * core/llm/leakedToolCalls could not recover the call, `rejected` names what
 * it saw so the note states the specific mistake ("`foo` is not a tool on
 * this menu", "the arguments did not parse") instead of a generic "try again".
 * The user note carries `notePrefix` so the history sanitiser drops it. Pure.
 *
 * @param {any} content
 * @param {any} thinkingForReplay
 * @param {{ notePrefix?: string, rejected?: any }} [opts]
 */
function emptyReplyRetryMessages(content, thinkingForReplay, { notePrefix, rejected } = {}) {
    const text = !isBlankReply(content) ? content : EMPTY_REPLY_PLACEHOLDER;
    const assistant = {
        role: 'assistant',
        content: text,
        ...(Array.isArray(thinkingForReplay) && thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
    };
    let note = 'Your previous reply contained no tool call and no message, so nothing was applied.';
    const seen = Array.isArray(rejected) ? rejected.filter(Boolean) : [];
    if (seen.length) {
        const detail = seen.map((r) => {
            if (r.reason === 'unknown_tool' && r.name) return `\`${r.name}\` is not a tool on this menu`;
            if (r.name) return `the arguments of \`${r.name}\` did not parse`;
            return 'a call whose JSON did not parse';
        });
        note += ` It DID contain a tool call written out as text (${[...new Set(detail)].join('; ')}) — text is never executed. Tools are called only through the function-calling interface, never written into your reasoning or your answer.`;
    }
    note += ' Answer now with the tool call itself — or, if the work is finished, with a short message to the user.';
    const user = { role: 'user', content: notePrefix ? `${notePrefix}\n${note}` : note };
    return [assistant, user];
}

/**
 * The provider's own words, short enough for an error bubble. Adapter errors
 * read `<name> API error <status>: <body>`; when the body is the usual
 * `{error:{message}}` JSON, that message is what the user needs to see (e.g. a
 * chat template refusing the request shape). Otherwise the raw tail, trimmed.
 */
function providerErrorExcerpt(message, max = 240) {
    const raw = String(message || '');
    const body = raw.replace(/^.*?API error \d{3}:\s*/s, '');
    let text = body;
    try {
        const j = JSON.parse(body);
        const inner = j && (j.error?.message || j.message || j.error);
        if (typeof inner === 'string' && inner.trim()) text = inner;
    } catch (_) { /* not JSON — use the raw tail */ }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The HTTP status an adapter error carries, or null. Adapter messages read
 * `<name> API error <status>: …`; a 4xx that is not 408/429 is the provider
 * refusing the request itself — resending it verbatim cannot help.
 */
function providerErrorStatus(err) {
    const m = /API error (\d{3})/.exec(String(err && err.message || err || ''));
    return m ? Number(m[1]) : null;
}

/**
 * Accumulate one round's usage into per-turn totals.
 *
 * Field names follow the adapters' shared 'done' payload shape
 * (prompt_tokens / completion_tokens / cached_tokens / cache_creation_tokens);
 * anything missing counts as 0 so a partial payload never NaNs the totals.
 */
function accumulateUsage(totals, u) {
    if (!totals || !u || typeof u !== 'object') return totals;
    totals.prompt += Number(u.prompt_tokens) || 0;
    totals.completion += Number(u.completion_tokens) || 0;
    totals.cached += Number(u.cached_tokens) || 0;
    totals.cacheCreation += Number(u.cache_creation_tokens) || 0;
    totals.rounds += 1;
    return totals;
}

/** Fresh per-turn totals in the shape accumulateUsage fills. */
function emptyUsageTotals() {
    return { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 };
}

/**
 * Parse a tool call's `arguments` defensively → { args, truncated }.
 * `truncated` fires only when a NON-EMPTY string fails to parse for a tool
 * that takes parameters (the signature of a reply cut off mid-call). Empty
 * args for a tool in `paramless` are valid.
 *
 * @param {any} raw
 * @param {string} toolName
 * @param {{ paramless?: Set<string> }} [opts]
 */
function parseToolArgs(raw, toolName, { paramless } = {}) {
    if (raw && typeof raw === 'object') return { args: raw, truncated: false };
    if (typeof raw !== 'string') return { args: {}, truncated: false };
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '{}') return { args: {}, truncated: false };
    try { return { args: JSON.parse(trimmed), truncated: false }; }
    catch { return { args: {}, truncated: !(paramless instanceof Set && paramless.has(toolName)) }; }
}

module.exports = {
    TRUNCATION_STOP_REASONS,
    TRUNCATION_PLACEHOLDER,
    EMPTY_REPLY_PLACEHOLDER,
    isBlankReply,
    isTruncatedStop,
    truncationRetryMessages,
    emptyReplyRetryMessages,
    providerErrorExcerpt,
    providerErrorStatus,
    accumulateUsage,
    emptyUsageTotals,
    parseToolArgs,
};
