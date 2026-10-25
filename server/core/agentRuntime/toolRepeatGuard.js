// @typecheck strict
/**
 * Per-turn guard against a model calling the same read-only tool with the
 * same arguments again, and against re-showing passages it already has.
 *
 * Unlike toolCallDedupe (side-effecting calls inside one batch), this spans
 * the whole turn and only concerns read-only tools.
 */

const { _defaultStableStringify } = require('./toolCallDedupe');

/**
 * A retrieved passage as far as the guard identifies it.
 * @typedef {{ chunk_id?: string | number | null, title?: string, content?: string, text?: string }} GuardChunk
 */

/**
 * @param {GuardChunk | null | undefined} c
 * @returns {string | null}
 */
function chunkKey(c) {
    if (!c || typeof c !== 'object') return null;
    if (c.chunk_id !== undefined && c.chunk_id !== null && c.chunk_id !== '') return `id:${c.chunk_id}`;
    return `${c.title || ''}::${(c.content || c.text || '').slice(0, 80)}`;
}

/**
 * @param {{ readOnlyTools?: Iterable<string> }} [opts]
 */
function createToolRepeatGuard({ readOnlyTools = [] } = {}) {
    const readOnly = new Set(readOnlyTools);
    const calls = new Set();
    const chunks = new Set();

    return {
        /**
         * @param {string} name
         * @param {unknown} args
         */
        isRepeat(name, args) {
            if (!readOnly.has(name)) return false;
            const key = `${name}|${_defaultStableStringify(args || {})}`;
            if (calls.has(key)) return true;
            calls.add(key);
            return false;
        },
        /**
         * Forget a tool's earlier calls, e.g. a document read after the document changed.
         * @param {string} name
         */
        forget(name) {
            for (const key of [...calls]) if (key.startsWith(`${name}|`)) calls.delete(key);
        },
        /** @param {GuardChunk[] | null | undefined} list */
        seedChunks(list) {
            for (const c of list || []) {
                const k = chunkKey(c);
                if (k) chunks.add(k);
            }
        },
        /**
         * @template {GuardChunk} C
         * @param {C[] | null | undefined} results
         * @returns {C[]}
         */
        filterNewChunks(results) {
            /** @type {C[]} */
            const fresh = [];
            for (const c of results || []) {
                const k = chunkKey(c);
                if (k && chunks.has(k)) continue;
                if (k) chunks.add(k);
                fresh.push(c);
            }
            return fresh;
        },
    };
}

module.exports = { createToolRepeatGuard };
