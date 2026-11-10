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

const AI_RELIABILITY_FIELDS = {
    temperature: { type: 'number', min: 0, max: 2, since: 3 },
    checks: { type: 'aiChecks', since: 3 },
    repairRounds: { type: 'int', min: 0, max: LIMITS.MAX_AI_REPAIR_ROUNDS, since: 3 },
};

/**
 * The field table with the reliability fields added at its end, in place: ACTION_SPECS and
 * STEP_SPECS share the AI field tables, so both get the same fields.
 * @template {object} T
 * @param {T} fields
 * @returns {T & typeof AI_RELIABILITY_FIELDS}
 */
function withAiReliability(fields) {
    return Object.assign(fields, AI_RELIABILITY_FIELDS);
}

module.exports = { withAiReliability };
