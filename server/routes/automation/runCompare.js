// @typecheck strict
/**
 * Compare two runs of one automation, step by step:
 *
 *   GET /runs/:runId/compare/:otherRunId?stepId=   → CompareResult
 *
 * CompareResult = { a, b, verdict: 'same'|'soft'|'changed', summary, steps, truncated }
 * (the shape and the meaning of each step's verdict are documented in
 * automation/testing/runCompare.js). `a` is the run in the path, `b` the other.
 *
 * Both runs go through the one door the test-data features share
 * (automation/testing/runDataAccess.js): the caller must hold a role on each
 * run's automation and may read its data, so a run id from another
 * organisation answers 404 exactly as it does on the run page, and a run on
 * the starter's own connections answers 403 `caller_run_private`. Only the legs
 * of each journey the caller may read are compared.
 *
 * Answers:
 *   400  runs_not_comparable: the two runs belong to different automations
 *   403  the caller may not read one of the runs
 *   404  a run does not exist, or the caller has no role on its automation
 *
 * The answer is cut values only (a glance at each difference, 200 characters)
 * and is sent `private, no-store`. Nothing here is offered over MCP.
 *
 * A comparison can open generated files, so it is limited per user:
 * AUTOMATION_RUN_COMPARE_RPM (30 a minute, 0 = unlimited).
 *
 * Built by a factory so a test hands in its own store, access and comparer.
 */

'use strict';

const express = require('express');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { queryOf, worded } = require('../../core/http/schemaParts');
const { makeAutomationAccess } = require('../../automation/access');
const { makeRunDataAccess } = require('../../automation/testing/runDataAccess');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { envCap } = require('../../automation/mcpRunReadCaps');
const { sessionUser } = require('../../core/http/sessionUser');

/** Comparisons per user per minute (a compare can open up to 50 generated files). 0 = unlimited. */
const compareRpm = () => envCap('AUTOMATION_RUN_COMPARE_RPM', 30);

const STEP_TEXT = 'stepId is the id of a step, up to 200 characters.';
const CompareQuery = queryOf({
    stepId: worded(STEP_TEXT).trim().min(1, STEP_TEXT).max(200, STEP_TEXT).optional(),
});

/**
 * @param {object} [overrides]
 * @param {any} [overrides.store]          automationStore surface
 * @param {any} [overrides.storage]        storageStore surface (streamFile), for file summaries
 * @param {any} [overrides.access]         the automation access guard
 * @param {any} [overrides.runDataAccess]  { readableRun }
 * @param {Function} [overrides.compareRuns]
 * @param {import('express').RequestHandler} [overrides.limiter]       middleware for the compare route
 */
function makeRunCompareRouter(overrides = {}) {
    const router = express.Router();
    const access = overrides.access
        || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const runData = overrides.runDataAccess || makeRunDataAccess({ store: overrides.store, access });
    const compare = /** @param {Parameters<typeof import('../../automation/testing/runCompare').compareRuns>} args */ (...args) => (overrides.compareRuns || require('../../automation/testing/runCompare').compareRuns)(...args);

    const rpm = compareRpm();
    const limiter = overrides.limiter
        || (rpm > 0 ? perUserRateLimit({ windowMs: 60_000, max: rpm }) : (_req, _res, next) => next());

    router.get('/runs/:runId/compare/:otherRunId', limiter, validate({ query: CompareQuery }), async (req, res) => {
        const first = await runData.readableRun(req, res, req.params.runId, 'compare it');
        if (!first) return undefined;
        const second = await runData.readableRun(req, res, req.params.otherRunId, 'compare it');
        if (!second) return undefined;
        if (first.run.automationId !== second.run.automationId) {
            throw new HttpError(400, 'runs_not_comparable', 'Only runs of the same automation can be compared.');
        }
        const result = await compare({
            runA: first.root, runB: second.root, legsA: first.legs, legsB: second.legs,
            viewerId: sessionUser(req).id, ignorePaths: [], stepId: /** @type {string | undefined} */ (req.query.stepId) || null,
        }, { store: overrides.store, storage: overrides.storage });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json(result);
    });

    return router;
}

module.exports = { makeRunCompareRouter };
