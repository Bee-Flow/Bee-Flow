// @typecheck strict
/**
 * The serialisation helpers one tool round and its caller share: what a tool
 * result looks like on the model's tool message, the size cap on it, the
 * flattening of tool round-trips for a wrap-up round, and the stable key the
 * loop brakes count on. Moved verbatim out of ../toolRoundExecutor.js, which
 * still exports every one of them under the same name.
 */
const { stableStringify } = require('../../../utils/stableJson');

/**
 * Serialize a tool result for the LLM's tool message.
 *
 * The server stores "internal" fields on tool results (prefixed with `_`,
 * or the `_action` dispatch field) which chatStream intercepts to emit SSE
 * events or save persistence state. The LLM only needs the *outcome*; sending
 * the bulky UI-facing payload (e.g. kb_sources' `_sources` duplicates `results`
 * at full 3000-char content) wastes tokens and distracts the model.
 *
 * Rules:
 *   - Strings pass through verbatim.
 *   - Special-case workspace_update → tiny confirmation.
 *   - Otherwise: drop every key starting with `_` (e.g. `_action`, `_sources`)
 *     and drop known noise fields (`instruction`, `resultCount`) that are
 *     superseded by the agent's system prompt.
 */
// Hard cap on tool result string fed to the model. A misbehaving tool that
// returns several megabytes of JSON can blow the context window or rack up
// token charges; truncate with a clear marker so the model knows.
const MAX_TOOL_CONTENT_BYTES = 128 * 1024;
/**
 * @param {string} s
 */
function truncateToolContent(s) {
    if (typeof s !== 'string') return s;
    if (s.length <= MAX_TOOL_CONTENT_BYTES) return s;
    return s.slice(0, MAX_TOOL_CONTENT_BYTES) + `\n…[tool output truncated at ${MAX_TOOL_CONTENT_BYTES} chars]`;
}
/**
 * @param {string | number | boolean | Record<string, unknown> | null | undefined} finalToolResult
 * @returns {string}
 */
function buildLLMToolContent(finalToolResult) {
    if (typeof finalToolResult === 'string') return truncateToolContent(finalToolResult);
    if (finalToolResult == null || typeof finalToolResult !== 'object') {
        return truncateToolContent(JSON.stringify(finalToolResult));
    }

    // Strip bulky notebook content — LLM only needs the confirmation message.
    if (finalToolResult._action === 'workspace_update' && finalToolResult.message) {
        return JSON.stringify({ action: 'notebook_updated', message: finalToolResult.message });
    }

    const NOISE_KEYS = new Set(['instruction', 'resultCount']);
    /** @type {Record<string, unknown>} */
    const clean = {};
    for (const [k, v] of Object.entries(finalToolResult)) {
        if (k.startsWith('_')) continue;     // Internal dispatch / UI-only fields
        if (NOISE_KEYS.has(k)) continue;     // Redundant with system prompt
        clean[k] = v;
    }
    return truncateToolContent(JSON.stringify(clean));
}

// Withholding the tool list is only half of a wrap-up round: the tool
// ROUND-TRIP has to leave the transcript with it. The Anthropic Messages API
// rejects a request that carries `tool_use`/`tool_result` blocks with no
// `tools` defined ("Requests which include `tool_use` or `tool_result` blocks
// must define tools"), and core/providers/claude.js only sets `params.tools`
// when `options.tools?.length > 0` while its normalizeMessages still converts
// the assistant `tool_calls` and `role:'tool'` rows into those blocks — so on
// the agent-chat default provider the wrap-up round 400'd and the turn ended
// on the same error banner the bail exists to avoid. Flattening each call and
// its result into plain prose keeps the context, keeps the request valid on
// every provider, and leaves no structured tool surface to call back into.
/**
 * @template {{ role?: string, content?: unknown, tool_calls?: Array<{ id?: string, function?: { name?: string, arguments?: unknown } } | null>, tool_call_id?: string }} M
 * @param {M[]} msgs
 * @returns {Array<M | { role: string; content: string; }>}
 */
function _flattenToolRoundTrips(msgs) {
    const nameById = new Map();
    /** @type {Array<M | { role: string; content: string; }>} */
    const out = [];
    for (const m of msgs) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            /** @type {string[]} */
            const lines = [];
            for (const tc of m.tool_calls) {
                const fn = (tc && tc.function) || {};
                const name = fn.name || 'tool';
                if (tc && tc.id) nameById.set(tc.id, name);
                const args = typeof fn.arguments === 'string'
                    ? fn.arguments
                    : JSON.stringify(fn.arguments || {});
                lines.push(`[Called tool ${name} with ${args}]`);
            }
            const head = typeof m.content === 'string' ? m.content : '';
            out.push({ role: 'assistant', content: [head, ...lines].filter(Boolean).join('\n') });
            continue;
        }
        if (m && m.role === 'tool') {
            const name = nameById.get(m.tool_call_id) || 'tool';
            const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            out.push({ role: 'user', content: `[Result of tool ${name}]\n${body}` });
            continue;
        }
        out.push(m);
    }
    return out;
}
/** @param {unknown} value */
function _stableStringify(value) {
    return stableStringify(value, { undefined: 'raw' });
}

module.exports = {
    MAX_TOOL_CONTENT_BYTES,
    truncateToolContent,
    buildLLMToolContent,
    _flattenToolRoundTrips,
    _stableStringify,
};
