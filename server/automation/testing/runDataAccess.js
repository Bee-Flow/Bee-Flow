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
const { assertCanReadRunData, canReadRunData, isCallerRun } = require('../../core/automationModel/callerRunVisibility');
const log = require('../../telemetry/log');

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

    /**
     * @param {any} req
     * @param {any} res
     * @param {string} runId
     * @param {string} [what]  completes "only they can ..." in the caller-run refusal
     * @returns {Promise<{ run: any, root: any, legs: any[], runIds: string[] }|null>}
     */
    async function readableRun(req, res, runId, what = 'see its data') {
        const me = req.session.user.id;
        const run = await store().getRun(runId);
        if (!run) throw new HttpError(404, 'run_not_found', 'Not found');
        // Not on this automation at all (another organisation, nobody shared it
        // with them): the run does not exist as far as they can tell.
        if (run.userId !== me) {
            const automation = await store().getAutomation(run.automationId).catch(() => null);
            const { role } = await access.roleFor(automation, me, { session: req.session });
            if (!role) throw new HttpError(404, 'run_not_found', 'Not found');
        }
        if (!await access.runGuard(req, res, run, 'read')) return null;
        assertCanReadRunData(run, me, what);
        const chain = await store().getRunsInChain(run.id).catch(() => [run]);
        const all = chain.length ? chain : [run];
        const legs = all.filter((leg) => leg.automationId === run.automationId && canReadRunData(leg, me));
        if (!legs.some((leg) => leg.id === run.id)) legs.push(run);
        const rootId = run.rootRunId || run.id;
        const root = all.find((leg) => leg.id === rootId)
            || all.find((leg) => !leg.parentRunId)
            || run;
        return { run, root, legs, runIds: legs.map((leg) => leg.id) };
    }

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
        const latest = await store().getLatestRunInChain(run.id).catch(() => null);
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
