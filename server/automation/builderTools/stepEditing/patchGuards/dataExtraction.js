// @typecheck
/**
 * builder_update_step on a data_extraction step: `fields` (the output shape)
 * replaced wholesale and `source` canonicalised, both through the add path's
 * sanitizers. Moved verbatim out of applyUpdateStep (stepEditing.js).
 */

const { sanitizeForEach } = require('../../bindings');
const { checkLoopRef } = require('../../outputFields');
const {
    sanitizeDataExtractionFields, sanitizeDataExtractionSource, loopItemSourceError,
} = require('../../stepBuilders/dataExtractionStep');

/** Applies the patch's fields/source to `next`: a refusal, or null. */
function patchDataExtraction(graph, step, patch, next, draftWrap, patchNotes) {
    // data_extraction.fields is the ARRAY of declared fields — the output shape
    // — so it too bypasses the bindKey machinery (which would read `fields` as
    // a binding map only on a set step, and skip it here): replaced wholesale
    // through the add tool's sanitizer. `source` is ONE binding, not the
    // `inputs` map, so it gets the add path's canonicalisation explicitly.
    if (step.type === 'data_extraction') {
        if ('fields' in patch) {
            const { fields, error } = sanitizeDataExtractionFields(patch.fields);
            if (error) return { error };
            next.fields = fields;
        }
        if ('source' in patch) {
            const src = sanitizeDataExtractionSource(patch.source, graph, draftWrap);
            if (src.error) return { error: src.error, ...(src._fixHint ? { _fixHint: src._fixHint } : {}) };
            next.source = src.source;
            patchNotes.push(...(src.notes || []));
            // The same item-shape check the add path runs, against the forEach
            // the step will have once this patch lands (a forEach in the same
            // patch counts; an invalid one is left for the forEach block below
            // to refuse). A patch was the one way the measured `loop.r.content`
            // could still reach a step after the add path learned to repair it.
            const fe = 'forEach' in patch
                ? (patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach)
                : step.forEach;
            if (fe && next.source.kind === 'ref' && typeof next.source.path === 'string' && next.source.path.startsWith(`loop.${fe.itemVar}.`)) {
                const chk = checkLoopRef(graph, next.source.path, fe, draftWrap);
                if (chk.ok && chk.path) {
                    next.source = { ...next.source, path: chk.path };
                    patchNotes.push(chk.note.replace(/^binding /, 'source '));
                } else if (!chk.ok) {
                    return loopItemSourceError(chk, fe, draftWrap);
                }
            }
        }
    }
    return null;
}

module.exports = { patchDataExtraction };
