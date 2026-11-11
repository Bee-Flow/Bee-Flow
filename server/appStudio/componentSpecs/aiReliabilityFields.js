// @typecheck strict
/**
 * App Studio catalog — the answer-reliability fields of the native AI steps (ai_generate,
 * ai_extract), schema v3: optional, nothing written out when absent. They are the automation
 * ai_step's checks run on the step's answer (appStudio/aiReliability.mts,
 * appStudio/actionExecutor/aiChecks.mts).
 *
 *   temperature   0..2; absent = the model tier's own setting
 *   checks        [{ kind: allowedFrom | numbersFrom | script | items, field, ... }] (shapes:
 *                 core/automationModel/aiStepReliabilitySpec.js; `ref` / `sameCountAs` read
 *                 form., vars., item., params. or value.)
 *   repairRounds  extra model calls with what failed, before the step fails; absent = 1
 *
 * Plain .js like the rest of componentSpecs: agent-hub's tests and typecheck load this directory.
 */

'use strict';

const { LIMITS } = require('./limits');

// The descriptions are what the AI builder reads in app_inspect_catalog: the first sentence is the
// extension index gloss (at most 72 characters, no semicolon), the rest says how to use the field.
const AI_RELIABILITY_FIELDS = {
    temperature: {
        type: 'number', min: 0, max: 2, since: 3,
        description: 'How much the answer may vary between runs, a number from 0 to 2. '
            + 'Use 0 to 0.3 for extraction, classification and anything checked, 0.7 or more for free drafts. '
            + 'Leave it out to keep the model tier\'s own setting (most steps should).',
    },
    checks: {
        type: 'aiChecks', since: 3,
        description: 'Rules every answer must pass before the step succeeds. '
            + 'A list (at most 20) of { kind, field, ... }. field is a path in the answer: a schema field of ai_generate with a schema ("category"), "text" for a plain ai_generate, "rows[].category" for ai_extract. '
            + 'Kinds: allowedFrom { ref, value?, ignoreCase?, allowEmpty? } (the answer is one of the list at ref, value names the key of each list item that holds the allowed value), '
            + 'numbersFrom { ref, tolerance?, ignoreUpTo?, percent?, ignoreDates? } (every number in the answer appears in the data at ref: no invented amounts), '
            + 'script { script, minRatio? } (written in latin, cyrillic, greek, arabic, hebrew, han, japanese, hangul, devanagari or thai), '
            + 'items { minItems?, maxItems?, sameCountAs? } (a list of the right length, sameCountAs a list path). '
            + 'ref and sameCountAs are paths into the step\'s own data: form.<input>, vars.<name>, item.<field>, params.<name> or value, no {{ }} and never secrets. '
            + 'A failing answer goes back to the AI with what failed (repairRounds), after that the step fails with ai_check_failed. Leave it out for no checks.',
    },
    repairRounds: {
        type: 'int', min: 0, max: LIMITS.MAX_AI_REPAIR_ROUNDS, since: 3,
        description: 'Extra AI calls that fix an answer which failed its checks. '
            + `A whole number from 0 to ${LIMITS.MAX_AI_REPAIR_ROUNDS}, only read when the step has checks. Leave it out for 1 round. `
            + 'Each round sends what failed back to the AI and costs one more AI call. 0 fails the step at the first failed check.',
    },
};

/**
 * The field table with the reliability fields added at its end, in place: ACTION_SPECS and
 * STEP_SPECS share the AI field tables, so both get the same fields.
 * @template {Record<string, unknown>} T
 * @param {T} fields
 * @returns {T & typeof AI_RELIABILITY_FIELDS}
 */
function withAiReliability(fields) {
    return Object.assign(fields, AI_RELIABILITY_FIELDS);
}

module.exports = { withAiReliability };
