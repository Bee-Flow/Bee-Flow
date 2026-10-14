/**
 * Same-batch dedup for side-effecting tool calls.
 *
 * When a model emits the identical tool call twice in one assistant turn
 * (hallucinated double-tap, or a stream retry that re-accumulated events),
 * executing both duplicates the side effect — e.g. two identical YouTrack
 * issues. Read-only duplicates are harmless (and occasionally intentional),
 * so only side-effecting calls are dropped.
 *
 * Fail-closed: when the classifier doesn't know a tool (MCP/n8n/dynamic
 * names), it is treated as side-effecting — an identical name+args pair in
 * one batch is virtually always a duplication bug, never a real intent.
 */

const { isSideEffect } = require('../automationModel/sideEffectMap');
const { stableStringify } = require('../../utils/stableJson');

function _defaultStableStringify(value) {
    return stableStringify(value, { undefined: 'raw' });
}

/**
 * @param {Array} toolCalls - OpenAI-format tool calls: { id, function: { name, arguments } }
 * @param {Object} [opts]
 * @param {Function} [opts.isSideEffect] - (toolName) => boolean; defaults to sideEffectMap
 * @param {Function} [opts.stableStringify] - deterministic serializer for the args key
 * @returns {{ kept: Array, dropped: number }}
 */
function dedupeSideEffectToolCalls(toolCalls, opts = {}) {
    const sideEffectFn = opts.isSideEffect || isSideEffect;
    const stringify = opts.stableStringify || _defaultStableStringify;

    const seen = new Set();
    const kept = [];
    let dropped = 0;

    for (const tc of toolCalls || []) {
        const name = tc?.function?.name || tc?.name || '';
        const rawArgs = tc?.function?.arguments ?? '';
        let key;
        try {
            key = `${name}|${stringify(JSON.parse(rawArgs || '{}'))}`;
        } catch {
            key = `${name}|${rawArgs}`;
        }

        if (seen.has(key) && sideEffectFn(name)) {
            dropped++;
            continue;
        }
        seen.add(key);
        kept.push(tc);
    }

    return { kept, dropped };
}

module.exports = { dedupeSideEffectToolCalls, _defaultStableStringify };
