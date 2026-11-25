// @typecheck strict
/**
 * The definition a journey keeps across a pause, when a feature started it on a definition of its own.
 *
 * A run that pauses (an approval, a form page) continues later in a new leg, on the definition of the automation
 * version it started on with the automation's current settings (./resume.js automationToResume). That is right for a
 * run of the automation itself. A feature that ran the automation on a copy it holds (a Cowork plan runs the copy
 * its owner approved, with notifications held to the owner) needs the rest of the journey to run on that same copy:
 * otherwise a change to the automation, or its own notification settings, would reach the second half.
 *
 * Such a feature fills the runner port `heldDefinitions` at boot (core/automationRunner/featurePorts.js):
 *
 *   definitionOf(run) → the definition this journey keeps, or null when the feature did not start it.
 *
 * The run is the paused row; the journey is its `rootRunId` (else its own id). A feature that does not know the run
 * answers null and the journey continues as any other. A feature that knows it but cannot answer (the copy it holds
 * was changed behind its back) throws: continuing on another definition is the one thing that may not happen.
 *
 * A feature that may not let the journey go on for a reason its owner should read (an organisation's policy that
 * changed during the pause) throws a ContinuationRefused: the decision then fails the run with that reason
 * (automation/approvalDecision.js) instead of a reason-less "could not continue".
 */

'use strict';

const { hasRunnerPort, runnerPort } = require('./featurePorts');

/** A refusal to continue a journey, in words for its owner. */
class ContinuationRefused extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ContinuationRefused';
    }
}

/**
 * @param {{ id?: string | null, rootRunId?: string | null, automationId?: string | null }} run  the paused run row
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function heldDefinitionOf(run) {
    if (!run || !hasRunnerPort('heldDefinitions')) return null;
    const port = /** @type {{ definitionOf: (run: object) => Promise<Record<string, unknown> | null> }} */ (/** @type {unknown} */ (runnerPort('heldDefinitions')));
    const held = await port.definitionOf(run);
    return held && typeof held === 'object' && !Array.isArray(held) ? held : null;
}

module.exports = { heldDefinitionOf, ContinuationRefused };
