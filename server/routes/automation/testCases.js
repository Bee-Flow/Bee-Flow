// @typecheck strict
/**
 * Test cases on a code step or a custom node.
 *
 *   GET    /:id/test-cases?stepId=       the cases (and the limits)      view
 *   GET    /:id/test-cases/:caseId       one case with its input values  view
 *   POST   /:id/test-cases               a case, typed or from a run     edit
 *   PUT    /:id/test-cases/:caseId       change it (a run input re-captures) edit
 *   DELETE /:id/test-cases/:caseId                                       edit
 *   POST   /:id/test-cases/run           run cases in the sandbox (TEST mode) edit
 *
 * A custom node (kind 'block') is its owner's, like routes/step.js: its writes
 * and runs need 'owner'.
 *
 * A case is an input, an expectation (success or error) and assertions from a
 * closed vocabulary. The input is typed in, or captured from a finished run:
 * the values the code step received are kept as a fixture, filtered to the
 * inputs the step declares now. Capture goes through the same door as every
 * run read (automation/testing/runDataAccess): a run the caller may not read,
 * or that used its starter's own connections, or that belongs to another
 * automation, gives nothing; an automation in a PRD stage keeps no test data.
 *
 * Cases run through the sandbox exactly as "Try it" does, so nothing leaves
 * Bee Flow. Not mounted here: routes/automation.js mounts the router.
 *
 * Built by a factory so a test hands in its own stores, access, sandbox and
 * limiter.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { envCap } = require('../../automation/mcpRunReadCaps');
const { findCodeStep, captureFixture, runTestCases } = require('../../automation/testing/testCases');
const { CreateBody, UpdateBody, RunBody, ListQuery } = require('./testCaseSchemas');
const { sessionUser } = require('../../core/http/sessionUser');

const perStepMax = () => envCap('AUTOMATION_TEST_CASES_PER_STEP_MAX', 50);
const assertionsMax = () => envCap('AUTOMATION_TEST_ASSERTIONS_MAX', 50);
const runRpm = () => envCap('AUTOMATION_TEST_RUN_RPM', 20);

/**
 * The input as the detail answer shows it.
 * @param {{ input: { kind: string, runId?: string | null } }} testCase
 * @param {{ available?: boolean, values?: unknown } | null | undefined} loaded
 */
function describeInput(testCase, loaded) {
    if (testCase.input.kind === 'typed') return { kind: 'typed', available: true, values: loaded?.values ?? null, runId: null };
    return {
        kind: 'run',
        available: !!loaded && loaded.available === true,
        values: loaded && loaded.available ? loaded.values : null,
        runId: testCase.input.runId ?? null,
    };
}

/**
 * @param {{
 *   store?: any, testingStore?: any, access?: any,
 *   sandbox?: any, runDataAccess?: { readableRun: Function, assertCapturable: Function, assertTestDataAllowed: Function },
 *   limiter?: import('express').RequestHandler, now?: () => number,
 * }} [overrides]
 */
function makeTestCasesRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const testing = () => overrides.testingStore || require('../../stores/automationTestingStore');
    const access = overrides.access
        || require('../../automation/access').makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const runData = overrides.runDataAccess
        || require('../../automation/testing/runDataAccess').makeRunDataAccess({ store: overrides.store, access });
    const limiter = overrides.limiter
        || (runRpm() > 0
            ? require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: runRpm() })
            : (_req, _res, next) => next());

    /**
     * The automation, once the caller holds the role the call needs. A custom
     * node's writes need its owner. `null` after a 404 or the guard's 403.
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {string} need
     */
    async function load(req, res, need) {
        const a = await store().getAutomation(req.params.id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return null; }
        const role = need !== 'view' && a.kind === 'block' ? 'owner' : need;
        const acc = await access.guard(req, res, a, role);
        return acc ? a : null;
    }

    /**
     * The code step a call names, else 404.
     * @param {{ definition?: unknown }} a
     * @param {string} stepId
     */
    function codeStepOf(a, stepId) {
        const step = findCodeStep(a.definition, stepId);
        if (!step) throw new HttpError(404, 'step_not_found', 'Not found');
        return step;
    }

    /**
     * Keep the input of a finished run as a fixture: the run must be this automation's, readable and finished.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {{ id: string }} a
     * @param {string} stepId
     * @param {{ runId: string, attempts?: number }} input
     */
    async function captureFromRun(req, res, a, stepId, input) {
        const found = await runData.readableRun(req, res, input.runId);
        if (!found) return null;
        if (found.run.automationId !== a.id) throw new HttpError(404, 'run_not_found', 'Not found');
        await runData.assertCapturable(found.run, found.legs);
        return captureFixture({ automation: a, stepId, run: found.run, legs: found.legs, attempts: input.attempts },
            { store: store(), testingStore: testing() });
    }

    router.get('/:id/test-cases', validate({ query: ListQuery }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
        const a = await load(req, res, 'view');
        if (!a) return;
        const testCases = await testing().listTestCases(a.id, req.query.stepId);
        res.json({ testCases, limits: { perStep: perStepMax(), assertions: assertionsMax() } });
    });

    router.get('/:id/test-cases/:caseId', async (req, res) => {
        const a = await load(req, res, 'view');
        if (!a) return;
        const testCase = await testing().getTestCase(a.id, req.params.caseId);
        if (!testCase) throw new HttpError(404, 'test_case_not_found', 'Not found');
        const loaded = await testing().getTestCaseInput(a.id, testCase.id);
        res.json({ testCase, input: describeInput(testCase, loaded) });
    });

    router.post('/:id/test-cases', validate({ body: CreateBody }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
        const a = await load(req, res, 'edit');
        if (!a) return;
        await runData.assertTestDataAllowed(a);
        const body = req.body;
        codeStepOf(a, body.stepId);
        const cap = perStepMax();
        if (cap > 0 && await testing().countTestCases(a.id, body.stepId) >= cap) {
            throw new HttpError(409, 'test_case_limit', `A step can have at most ${cap} test cases.`);
        }
        /** @type {string | null} */
        let fixtureId = null;
        if (body.input.kind === 'run') {
            const fixture = await captureFromRun(req, res, a, body.stepId, body.input);
            if (!fixture) return;
            fixtureId = fixture.id;
        }
        const testCase = await testing().createTestCase({
            automationId: a.id,
            stepId: body.stepId,
            name: body.name,
            inputKind: body.input.kind,
            typedInput: body.input.kind === 'typed' ? body.input.values : undefined,
            fixtureId,
            expect: body.expect || 'success',
            assertions: body.assertions || [],
            createdBy: sessionUser(req).id,
        });
        res.status(201).json({ testCase });
    });

    router.put('/:id/test-cases/:caseId', validate({ body: UpdateBody }), async (/** @type {import('express').Request<{ id: string, caseId: string }>} */ req, res) => {
        const a = await load(req, res, 'edit');
        if (!a) return;
        await runData.assertTestDataAllowed(a);
        const existing = await testing().getTestCase(a.id, req.params.caseId);
        if (!existing) throw new HttpError(404, 'test_case_not_found', 'Not found');
        const { name, expect, assertions, input } = req.body;
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (expect !== undefined) patch.expect = expect;
        if (assertions !== undefined) patch.assertions = assertions;
        if (input) {
            if (input.kind === 'typed') {
                Object.assign(patch, { inputKind: 'typed', typedInput: input.values });
            } else {
                codeStepOf(a, existing.stepId);
                const fixture = await captureFromRun(req, res, a, existing.stepId, input);
                if (!fixture) return;
                Object.assign(patch, { inputKind: 'run', fixtureId: fixture.id });
            }
        }
        const testCase = await testing().updateTestCase(a.id, existing.id, patch);
        if (!testCase) throw new HttpError(404, 'test_case_not_found', 'Not found');
        res.json({ testCase });
    });

    router.delete('/:id/test-cases/:caseId', async (req, res) => {
        const a = await load(req, res, 'edit');
        if (!a) return;
        // No PRD check: removing test data is always allowed.
        const deleted = await testing().deleteTestCase(a.id, req.params.caseId);
        if (!deleted) throw new HttpError(404, 'test_case_not_found', 'Not found');
        res.json({ deleted: true });
    });

    router.post('/:id/test-cases/run', limiter, validate({ body: RunBody }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
        const a = await load(req, res, 'edit');
        if (!a) return;
        const { stepId, caseIds, code } = req.body;
        const step = codeStepOf(a, stepId);
        let cases;
        if (caseIds) {
            cases = [];
            for (const id of [...new Set(caseIds)]) {
                const c = await testing().getTestCase(a.id, id);
                if (!c || c.stepId !== stepId) throw new HttpError(404, 'test_case_not_found', 'Not found');
                cases.push(c);
            }
        } else {
            cases = await testing().listTestCases(a.id, stepId);
        }
        const orgId = a.organizationId || req.session?.user?.organizationId || req.session?.user?.id || null;
        const out = await runTestCases(
            { automation: a, step, cases, code, orgId },
            { testingStore: testing(), ...(overrides.sandbox ? { sandbox: overrides.sandbox } : { getSandbox: () => require('../../automation/codeSandbox') }), now: overrides.now },
        );
        res.json(out);
    });

    return router;
}

module.exports = { makeTestCasesRouter };
