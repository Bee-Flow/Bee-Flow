// @typecheck strict
/**
 * What Cowork lends the automation runner (core/automationRunner/featurePorts.js), loaded by
 * boot/featureRegistrations.js:
 *
 *   heldDefinitions  a plan's journey continues after a pause on the copy its owner approved (./planHeldDefinition.mts)
 *   approvalDeciders who may decide a question a plan run asks: its owner or the item's current approver
 *                    (./planQuestionDecider.mts), asked by automation/approvalService.js before any decision
 *
 * Lazy, like every registering module: a port costs nothing until a paused run continues or a question is decided.
 */

'use strict';

const { registerRunnerPorts } = require('../automationRunner/featurePorts');

registerRunnerPorts({
    heldDefinitions: {
        definitionOf: (/** @type {{ id?: string | null, rootRunId?: string | null, automationId?: string | null }} */ run) => require('./planHeldDefinition.mts').heldPlanDefinition(run),
    },
    approvalDeciders: {
        mayDecide: (/** @type {import('./planQuestionDecider.mts').QuestionRow} */ approval, /** @type {string} */ deciderId) => require('./planQuestionDecider.mts').mayDecideQuestion(approval, deciderId),
    },
});
