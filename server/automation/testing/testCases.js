// @typecheck strict
/**
 * Test cases on a code step or a custom node: the domain logic behind
 * routes/automation/testCases.js, with its dependencies injected.
 *
 *   findCodeStep(definition, stepId)   the code step, wherever it sits
 *   captureFixture({...}, deps)        keep a finished run's input to one step
 *   runTestCases({...}, deps)          run cases through the sandbox in TEST mode
 *
 * A case runs the code exactly as "Try it" does (automation/testing/codeTestRun):
 * every call to the outside is recorded and answered with a placeholder, so
 * nothing leaves Bee Flow. An assertion is data from a closed vocabulary
 * (automation/testing/assertions), never code.
 *
 * What is captured is only what the CURRENT step reads: the keys of its
 * `inputs` (secretKeys excluded) taken from the run's recorded input, so a
 * fixture cannot carry a value the step no longer asks for.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { walkAllSteps } = require('../../core/packaging/walkers');
const { isTruncatedOutput } = require('../../core/automationModel/payloadTruncation');
const { envCap } = require('../mcpRunReadCaps');
const { evaluateAssertions } = require('./assertions');
const { runCodeOnce } = require('./codeTestRun');

const fixtureMaxBytes = () => envCap('AUTOMATION_TEST_FIXTURE_MAX_BYTES', 1024 * 1024);

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @type {Record<string, string>} Refusal code of codeTestRun to the reason a result reports. */
const REASON_OF = Object.freeze({
    code_syntax_error: 'code_syntax_error',
    code_blocked: 'code_blocked',
    code_param_invalid: 'code_param_invalid',
    code_sandbox_missing: 'sandbox_missing',
});

/**
 * The code step `stepId` in a definition: a root step, a loop or parallel body
 * step, or a step of any layer. Only a step of type 'code' qualifies.
 *
 * @param {any} definition
 * @param {string} stepId
 * @returns {any|null}
 */
function findCodeStep(definition, stepId) {
    /** @type {any} */
    let found = null;
    walkAllSteps(definition, (/** @type {any} */ s) => {
        if (!found && s && s.id === stepId && s.type === 'code') found = s;
    });
    return found;
}

/**
 * The input names a code step reads (its `inputs` keys), without the secret declaration.
 * @param {any} step
 */
function declaredInputNames(step) {
    return isObject(step?.inputs) ? Object.keys(step.inputs).filter((k) => k !== 'secretKeys') : [];
}

/**
 * Keep the input one step received in a run, as a fixture.
 *
 * @param {{ automation: any, stepId: string, run: any, legs?: any[], attempts?: number }} args
 * @param {{ store: any, testingStore: any }} deps
 * @returns {Promise<{ id: string }>}
 */
async function captureFixture({ automation, stepId, run, legs, attempts }, deps) {
    const step = findCodeStep(automation?.definition, stepId);
    if (!step) throw new HttpError(404, 'step_not_found', 'Not found');
    const readable = new Set((legs && legs.length ? legs : [run]).map((/** @type {{ id: string }} */ l) => l.id));
    const rows = (await deps.store.getRunStepsForChain(run.id))
        .filter((/** @type {any} */ r) => r.stepId === stepId && readable.has(r.runId) && r.input !== undefined && r.input !== null);
    const row = attempts != null ? rows.find((/** @type {any} */ r) => r.attempts === attempts) : rows[rows.length - 1];
    if (!row) throw new HttpError(422, 'step_not_in_run', 'This step has no recorded input in that run.');
    if (isTruncatedOutput(row.input)) {
        throw new HttpError(422, 'fixture_truncated', 'The input of this step was too large to be recorded in full, so it cannot be used as test data.');
    }
    const source = isObject(row.input) ? row.input : {};
    /** @type {Record<string, any>} */
    const input = {};
    for (const name of declaredInputNames(step)) {
        if (Object.prototype.hasOwnProperty.call(source, name)) input[name] = source[name];
    }
    const cap = fixtureMaxBytes();
    if (cap > 0 && Buffer.byteLength(JSON.stringify(input), 'utf8') > cap) {
        throw new HttpError(413, 'fixture_too_large', 'The input of this step is too large to keep as test data.');
    }
    return deps.testingStore.createFixture({ automationId: automation.id, runId: run.id, stepId, input });
}

/** @param {string} expected */
const EMPTY_EXPECTATION = (expected) => ({ expected, got: /** @type {string | null} */ (null) });

/** @typedef {{ caseId: string, name: string, status: string, reason: string | null, expectation: { expected: string, got: string | null }, assertions: import('./assertions').AssertionResult[], logs: unknown[], calls: unknown[], durationMs: number, result?: unknown, error?: string }} CaseResult */

/**
 * The result of one case: always the full contract shape.
 * @param {{ id: string, name: string, expect: string, assertions: any[] }} c
 * @param {{ automation: any, step: any, code?: string, orgId?: string | null }} ctx
 * @param {{ testingStore: any, sandbox?: any, getSandbox?: () => any, now?: () => number }} deps
 * @returns {Promise<CaseResult>}
 */
async function runOneCase(c, { automation, step, code, orgId }, deps) {
    /** @type {CaseResult} */
    const base = {
        caseId: c.id, name: c.name, status: 'unusable', reason: null,
        expectation: EMPTY_EXPECTATION(c.expect), assertions: [], logs: [], calls: [], durationMs: 0,
    };
    const input = await deps.testingStore.getTestCaseInput(automation.id, c.id);
    if (!input || input.available === false) return { ...base, reason: 'fixture_expired' };

    const out = await runCodeOnce({
        code: typeof code === 'string' ? code : step.code,
        inputs: isObject(input.values) ? input.values : {},
        allowedTools: Array.isArray(step.allowedTools) ? step.allowedTools : [],
        allowedHosts: Array.isArray(step.allowedHosts) ? step.allowedHosts : [],
        limits: isObject(step.limits) ? step.limits : {},
        concurrencyKey: orgId ?? null,
    }, { sandbox: deps.sandbox, getSandbox: deps.getSandbox, now: deps.now });

    if (out.refusal) {
        return { ...base, status: 'error', reason: REASON_OF[out.refusal.code] || out.refusal.code, error: out.refusal.message };
    }
    const got = out.ok ? 'success' : 'error';
    const met = got === c.expect;
    // Assertions read the result of a success, or the message of an expected
    // error. When the outcome is not the expected one there is nothing sensible to read.
    const target = c.expect === 'error' ? { message: out.ok ? '' : out.error } : out.result;
    const assertions = met ? evaluateAssertions(target, c.assertions) : [];
    const pass = met && assertions.every((a) => a.ok);
    return {
        ...base,
        status: pass ? 'pass' : 'fail',
        expectation: { expected: c.expect, got },
        assertions,
        ...(out.ok ? { result: out.result } : { error: out.error }),
        logs: out.logs,
        calls: out.calls,
        durationMs: out.durationMs,
    };
}

/**
 * Run `cases` one after the other and keep each verdict on its case.
 *
 * @param {{ automation: any, step: any, cases: any[], code?: string, orgId?: string|null }} args
 * @param {{ testingStore: any, sandbox?: any, getSandbox?: () => any, now?: () => number }} deps
 */
async function runTestCases({ automation, step, cases, code, orgId }, deps) {
    /** @type {CaseResult[]} */
    const results = [];
    for (const c of cases) {
        const result = await runOneCase(c, { automation, step, code, orgId }, deps);
        await deps.testingStore.recordTestCaseResult(automation.id, c.id, { status: result.status });
        results.push(result);
    }
    /** @param {string} status */
    const count = (status) => results.filter((r) => r.status === status).length;
    return {
        stepId: step.id,
        results,
        summary: { passed: count('pass'), failed: count('fail'), errored: count('error'), unusable: count('unusable') },
    };
}

module.exports = { findCodeStep, declaredInputNames, captureFixture, runTestCases, fixtureMaxBytes };
