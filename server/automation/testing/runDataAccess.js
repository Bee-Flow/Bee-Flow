// @typecheck
/**
 * The one door the test-data features (test cases, golden runs, form scenarios,
 * run compare) use to read a finished run.
 *
 * Reading a run for test data is the same act as reading its files
 * (routes/automation/runFiles.js): the credential is the run's own read guard
 * plus `assertCanReadRunData`, and everything that follows goes THROUGH the
 * legs of the journey the caller may read. This module holds that rule once.
 *
 *   readableRun(req, res, runId)   the run, its root, its readable legs, or null
 *                                  after the guard answered 403
 *   assertCapturable(run, legs)    a run whose values may be kept as test data
 *   assertTestDataAllowed(a)       not on an automation in a PRD stage
 *
 * Answers:
 *   404 run_not_found       the run does not exist, or the caller has no role on
 *                           its automation at all (they cannot tell it exists)
 *   403                     the caller is on the automation but may not read this
 *                           run, or it used the starter's own connections
 *   409 caller_run_not_capturable  a leg used the starter's connections: its data
 *                           belongs to that person, never to a saved fixture
 *   409 run_not_finished    the journey is still running or paused
 *   409 test_data_not_on_prd  PRD stages keep no test data. A failing stage
 *                           lookup refuses too: fail closed.
 *
 * Built by a factory so a test hands in its own store, access and stage lookup.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { makeAutomationAccess } = require('../access');
const { makeJourneyReader } = require('../journeyReader');
const { isCallerRun } = require('../../core/automationModel/callerRunVisibility');
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');

const FINISHED = new Set(['success', 'error', 'cancelled']);

/**
 * @param {{
 *   store?: any,
 *   access?: { roleFor: Function, runGuard: Function },
 *   managedInfo?: (projectId: string|null|undefined) => Promise<{ stage?: string }|null|undefined>,
 * }} [overrides]
 */
function makeRunDataAccess(overrides = {}) {
    const store = () => overrides.store || require('../../stores/automationStore');
    const access = overrides.access
        || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const managedInfo = overrides.managedInfo
        || ((projectId) => require('../../stores/managedPartsDefault').managedInfo(projectId));

    /** The run, its root, its readable legs and their ids; null after a 403 was written. */
    const readableRun = makeJourneyReader({ store, access, what: 'see its data' });

    /**
     * @param {any} run
     * @param {any[]} legs
     */
    async function assertCapturable(run, legs) {
        const list = Array.isArray(legs) && legs.length ? legs : [run];
        if (list.some((leg) => isCallerRun(leg)) || isCallerRun(run)) {
            throw new HttpError(409, 'caller_run_not_capturable',
                'This run used the connections of the person who started it, so its data cannot be saved as test data.');
        }
        const latest = await store().getLatestRunInChain(run.id).catch((e) => fallback('automation/testing/runDataAccess:assertCapturable', e, null));
        const status = (latest || run).status;
        if (!FINISHED.has(status)) throw new HttpError(409, 'run_not_finished', 'This run has not finished yet.');
    }

    /** @param {{ projectId?: string|null }|null|undefined} automation */
    async function assertTestDataAllowed(automation) {
        let stage;
        try {
            stage = (await managedInfo(automation?.projectId))?.stage;
        } catch (e) {
            log.warn(`[automation testing] stage lookup failed, test data refused: ${e.message}`);
            stage = 'prd';
        }
        if (stage === 'prd') {
            throw new HttpError(409, 'test_data_not_on_prd', 'Test data is not kept for automations in a PRD stage.');
        }
    }

    return { readableRun, assertCapturable, assertTestDataAllowed };
}

module.exports = { makeRunDataAccess };
