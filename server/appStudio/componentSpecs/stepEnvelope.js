// @typecheck strict
/**
 * App Studio catalog — the error-handling ENVELOPE of a sequence step: fields any
 * server step may carry next to its own.
 *
 *   onError: { steps, stop? }  runs when the step fails (then the sequence goes on;
 *                              stop: true ends it quietly)
 *   retry:   { times, delayMs } tries the step again first, when a retry can help
 *
 * Spread into NEW field tables, never written into the shared ones: ACTION_SPECS
 * (bare actions) shares AI_GENERATE_FIELDS and friends with STEP_SPECS, and a bare
 * action keeps its own `onError` effects. `envelope: true` lets the catalog explain
 * the two fields once instead of per kind. A kind whose effect leaves Bee Flow
 * (stepFlow.RETRY_UNSAFE_KINDS, or `retrySafe: false` on a registry kind) takes no retry: a second attempt would send the
 * mail or start the run twice. call_action takes onError but no retry (a retry
 * would re-run every step of the called action).
 *
 * Plain .js like the rest of componentSpecs: agent-hub's tests and typecheck load
 * this directory, and they do not run with the options a .mts require needs.
 */

'use strict';

const { RETRY_UNSAFE_KINDS } = require('../../shared/appDefinition/stepFlow.mjs');

const RETRY_FIELD = Object.freeze({ type: 'retry', envelope: true });
const ERROR_HANDLER_FIELD = Object.freeze({ type: 'errorHandler', envelope: true });

/**
 * Give every `mutatesData` step spec (and call_action) the envelope fields, in place
 * on the step table, each spec's `fields` replaced by a new object.
 *
 * @param {Record<string, { mutatesData?: boolean, retrySafe?: boolean, fields: Record<string, unknown> }>} stepSpecs
 */
function withErrorEnvelope(stepSpecs) {
    for (const [kind, spec] of Object.entries(stepSpecs)) {
        if (spec.mutatesData) {
            spec.fields = { ...spec.fields, ...(RETRY_UNSAFE_KINDS.includes(kind) || spec.retrySafe === false ? {} : { retry: RETRY_FIELD }), onError: ERROR_HANDLER_FIELD };
        } else if (kind === 'call_action') {
            spec.fields = { ...spec.fields, onError: ERROR_HANDLER_FIELD };
        }
    }
    return stepSpecs;
}

module.exports = { withErrorEnvelope };
