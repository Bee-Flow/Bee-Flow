// @typecheck strict
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

/** @param {unknown} value */
function _defaultStableStringify(value) {
    return stableStringify(value, { undefined: 'raw' });
}

/**
 * @template {{ id?: string, name?: string, function?: { name?: string, arguments?: string } }} T
 * @param {T[]} toolCalls - OpenAI-format tool calls: { id, function: { name, arguments } }
 * @param {{ isSideEffect?: (toolName: string) => boolean, stableStringify?: (value: unknown) => string }} [opts]
 *   `isSideEffect`: (toolName) => boolean; defaults to sideEffectMap; `stableStringify`: deterministic
 *   serializer for the args key
 * @returns {{ kept: T[], dropped: number }}
 */
function dedupeSideEffectToolCalls(toolCalls, opts = {}) {
    const sideEffectFn = opts.isSideEffect || isSideEffect;
    const stringify = opts.stableStringify || _defaultStableStringify;

    const seen = new Set();
    /** @type {T[]} */
    const kept = [];
    let dropped = 0;

    for (const tc of toolCalls || []) {
        const name = tc?.function?.name || tc?.name || '';
        const rawArgs = tc?.function?.arguments ?? '';
        /** @type {string} */
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
