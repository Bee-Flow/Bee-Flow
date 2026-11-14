// @typecheck strict
/**
 * Builder tools — the `_hint` each step of a dry run carries back to the
 * model. Required from the ../builderTools facade and ./toolDispatch.
 */

'use strict';

const { findStepAnywhere } = require('./draftGraph');
const { resolveStoredOutput } = require('./storedOutput.mts');

/**
 * @typedef {Parameters<typeof import('./refCheck').rememberStepShape>[0]} DraftWrap
 * @typedef {NonNullable<NonNullable<Parameters<typeof resolveStoredOutput>[1]>['readFullOutput']>} ReadFullOutput
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} out */
function outputTypeOf(out) {
    if (Array.isArray(out)) return 'array';
    return out === null || out === undefined ? 'null' : typeof out;
}

/**
 * What the step really returned, kept on the wrapper for the binding checks
 * of the calls that follow in this turn.
 * @param {DraftWrap | null | undefined} draftWrap
 * @param {string} stepId
 * @param {unknown} out
 * @param {boolean | undefined} partial
 */
function rememberShape(draftWrap, stepId, out, partial) {
    if (out === undefined || !draftWrap || !draftWrap.def) return;
    const found = findStepAnywhere(draftWrap.def, stepId);
    if (found) require('./refCheck').rememberStepShape(draftWrap, found.step, out, { partial });
}

/**
 * The `_hint` a dry-run step carries for the model: the output's type, its
 * top-level keys and a DEEP one-line shape in the run's own path grammar
 * (`messages[*]: { payload: { parts[*]: { body: { data } } } }`), the union
 * of every list entry, JSON text shown as what it encodes. Keys and types,
 * never values.
 *
 * An output over the 256 KB row cap is stored as a sentinel; its own keys
 * (`__truncated__`, `headSample`) are not the step's fields, and hinting
 * them taught the model to bind `steps.x.output.headSample`. The full copy
 * kept beside the row is read instead (or the sentinel's shape-preserving
 * preview when there is no copy). What the step really returned is also
 * remembered on the draft wrap for the rest of the turn, so the binding
 * checks of the next calls see this run's real shape (refCheck.js) — the
 * preview as `partial`: it cut lists and wide records, so nothing it lacks
 * is a reason to refuse, or even to doubt, a binding.
 * @param {{ stepId: string, output?: unknown }} s  one step row of the run
 * @param {DraftWrap | null | undefined} draftWrap
 * @param {{ readFullOutput?: ReadFullOutput | null }} [opts]
 */
async function dryRunHint(s, draftWrap, { readFullOutput = null } = {}) {
    const stored = await resolveStoredOutput(s.output, { readFullOutput });
    // An approval's routing preview (`_preview`) is for the author, not a field
    // a step can bind: it stays out of the shape and the keys.
    const { withoutPreview, simulatedPauseNote } = require('../testing/dryRunWarnings.mts');
    const out = withoutPreview(stored.out);
    const record = isRecord(out) ? out : null;
    const note = [
        stored.note,
        // Nobody answered: say so, so the model does not rebind steps against an
        // approval nobody was asked about, or a page nobody filled in.
        simulatedPauseNote(out),
        // A step on a table that is only proposed ran against nothing: say so, so
        // the model does not read the empty result as "the table has no rows".
        record && record._pendingTable ? 'table not created yet: a preview reads no rows and writes nothing' : null,
    ].filter(Boolean).join('; ');
    const shape = out !== null && typeof out === 'object' ? require('../shapeCache').shapeHintOf(out) : null;
    rememberShape(draftWrap, s.stepId, out, stored.partial);
    return {
        outputType: outputTypeOf(out),
        topKeys: record ? Object.keys(record) : null,
        shape,
        ...(note ? { note } : {}),
    };
}

module.exports = { dryRunHint };
