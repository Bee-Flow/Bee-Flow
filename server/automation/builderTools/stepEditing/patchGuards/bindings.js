// @typecheck
/**
 * builder_update_step — the `inputs` (or a set step's `fields`) binding map
 * of a patch, merged by key or replaced. Moved verbatim out of
 * applyUpdateStep (stepEditing.js).
 */

const { validateAndFixBindings, checkLoopBindings } = require('../../bindings');

    // inputs / fields: merge-by-key (null deletes) unless inputsMode:'replace'.
    // Only the keys the patch names are canonicalised and checked. The rest
    // are the author's own mappings: they stay byte-identical. Re-running the
    // whole merged map through the canonicaliser is how one AI edit of
    // `subject` would rewrite a hand-mapped `to` from value[0].from… to the
    // unreadable value.0.from….
/** Applies the binding map onto `next`: a refusal, or null. */
function patchBindingMap(graph, step, patch, next, { feAfter, draftWrap, inputsMode, patchNotes }) {
    const bindKey = step.type === 'set' ? 'fields' : 'inputs';
    if (bindKey in patch) {
        const mode = inputsMode === 'replace' ? 'replace' : 'merge';
        const raw = (patch[bindKey] && typeof patch[bindKey] === 'object') ? patch[bindKey] : {};
        const sent = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
        const bound = validateAndFixBindings(sent, graph, { draftWrap });
        if (bound.error) {
            return {
                error: bound.error,
                ...(bound._suggestedPatch ? { _suggestedPatch: { ops: bound._suggestedPatch.ops.map(o => ({ ...o, path: `patch.${bindKey}${o.path.slice('inputs'.length)}` })) } } : {}),
            };
        }
        const loop = checkLoopBindings(bound.inputs, graph, feAfter, draftWrap, { label: bindKey });
        if (loop.error) return { error: loop.error };
        const inputs = loop.value;
        const notes = [...(bound.notes || []), ...loop.notes];
        if (mode === 'merge') {
            const merged = { ...(step[bindKey] || {}) };
            for (const k of Object.keys(raw)) { if (raw[k] === null) delete merged[k]; else merged[k] = inputs[k]; }
            next[bindKey] = merged;
        } else {
            next[bindKey] = inputs;
        }
        patchNotes.push(...notes.map(n => (bindKey === 'fields' ? n.replace(/^inputs\./, 'fields.') : n)));
    }
    return null;
}

module.exports = { patchBindingMap };

/** @typedef {import('../../draftGraph').DraftGraph} DraftGraph */

/** @typedef {import('../../pendingDatatables').DraftWrap} DraftWrap */
