// @typecheck noImplicitAny
/**
 * Form scenarios: the answers somebody gave to an automation's forms in a real
 * run, saved by name so the automation can be tried again without typing them.
 *
 *   GET    /:id/form-scenarios                       the list (no answers)
 *   GET    /:id/form-scenarios/:scenarioId           one, with its answers
 *   POST   /:id/form-scenarios                       save a run's answers  { name, fromRunId }
 *   PUT    /:id/form-scenarios/:scenarioId           rename                { name }
 *   DELETE /:id/form-scenarios/:scenarioId
 *   POST   /:id/form-scenarios/:scenarioId/dry-run   dry run with the answers { triggerStepId? }
 *
 * Saving reads a finished run through the one door the test-data features share
 * (automation/testing/runDataAccess.js): the caller must be able to read that
 * run's data, the run must not have used its starter's own connections, and a
 * PRD stage keeps no test data. What is kept is decided by
 * automation/testing/formAnswers.js: typed answers only, never an uploaded file
 * or a record picked from an app.
 *
 * The dry run goes through the ordinary dry-run path with a test harness
 * (core/automationRunner/testHarness.js): every form page the scenario has
 * answers for is played from them, nothing pauses, nothing is sent.
 *
 * Answers:
 *   404  automation, scenario or run not found (also: a run of another automation)
 *   409  caller_run_not_capturable | run_not_finished | test_data_not_on_prd
 *        | scenario_name_taken | scenario_limit
 *   413  scenario_too_large
 *   422  no_form_answers: the run holds no form answers to save
 *
 * Built by a factory so a test hands in its own stores, access and runner.
 * Limits (env, 0 = unlimited): AUTOMATION_FORM_SCENARIOS_MAX (50),
 * AUTOMATION_FORM_SCENARIO_MAX_BYTES (262144).
 */

'use strict';

const express = require('express');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { bodyOf, worded } = require('../../core/http/schemaParts');
const { makeAutomationAccess } = require('../../automation/access');
const { makeRunDataAccess } = require('../../automation/testing/runDataAccess');
const { makeGuarded } = require('./guardedAutomation');
const { answersFromJourney, answersSize, hasAnswers } = require('../../automation/testing/formAnswers');
const { envCap } = require('../../automation/mcpRunReadCaps');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { entryDefinitionOf, resolveTriggerStepId } = require('./runEntry');
const { sessionUser } = require('../../core/http/sessionUser');

const NAME_TEXT = 'name is 1 to 80 characters.';
const CreateBody = bodyOf({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(80, NAME_TEXT),
    fromRunId: worded('fromRunId is the id of a finished run of this automation.').trim().min(1, 'fromRunId is the id of a finished run of this automation.').max(200, 'fromRunId is the id of a finished run of this automation.'),
});
const RenameBody = bodyOf({ name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(80, NAME_TEXT) });
const TRIGGER_TEXT = 'triggerStepId is the id of a trigger on this automation.';
const DryRunBody = bodyOf({ triggerStepId: worded(TRIGGER_TEXT).trim().min(1, TRIGGER_TEXT).max(200, TRIGGER_TEXT).nullish() });

const maxScenarios = () => envCap('AUTOMATION_FORM_SCENARIOS_MAX', 50);
const maxScenarioBytes = () => envCap('AUTOMATION_FORM_SCENARIO_MAX_BYTES', 262144);

/**
 * One scenario as the client sees it: an explicit allow-list, never the row.
 * @param {ReturnType<typeof import('../../stores/lib/automationTestingScenarios').rowToScenario>} row
 */
function describeScenario(row) {
    return {
        scenarioId: row.id,
        name: row.name,
        sourceRunId: row.sourceRunId,
        createdAt: row.createdAt,
        createdBy: row.createdBy ?? null,
        hasTriggerAnswers: !!row.hasTriggerAnswers,
        pages: Array.isArray(row.pages) ? row.pages.map((p) => ({ stepId: p.stepId, fieldCount: p.fieldCount })) : [],
        skipped: Array.isArray(row.skipped) ? row.skipped.map((s) => ({ stepId: s.stepId ?? null, field: s.field, reason: s.reason })) : [],
    };
}

/**
 * @param {object} [overrides]
 * @param {any} [overrides.store]            automationStore surface (getAutomation, getVersionDefinition, getRunStepsForChain, getRunSteps)
 * @param {any} [overrides.testingStore]     automationTestingStore surface (form scenario functions)
 * @param {any} [overrides.access]           the automation access (guard; roleFor and runGuard too when runDataAccess is not injected)
 * @param {any} [overrides.runDataAccess]    { readableRun, assertCapturable, assertTestDataAllowed }
 * @param {Function} [overrides.executeAutomation]
 * @param {import('express').RequestHandler} [overrides.limiter]     middleware for the dry-run route
 */
function makeFormScenariosRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const testing = () => overrides.testingStore || require('../../stores/automationTestingStore');
    const access = overrides.access
        || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const runData = overrides.runDataAccess || makeRunDataAccess({ store: overrides.store, access });
    const execute = /** @param {Parameters<typeof import('../../core/automationRunner').executeAutomation>} args */ (...args) => (overrides.executeAutomation || require('../../core/automationRunner').executeAutomation)(...args);
    const rpm = parseInt(process.env.AUTOMATION_RUN_TRIGGER_RPM || '', 10) || 30;
    const limiter = overrides.limiter || perUserRateLimit({ windowMs: 60_000, max: rpm });

    const guarded = makeGuarded({ store, access });

    /**
     * @param {{ id: string }} a
     * @param {string} scenarioId
     */
    async function scenarioOf(a, scenarioId) {
        const row = await testing().getFormScenario(a.id, scenarioId);
        if (!row) throw new HttpError(404, 'scenario_not_found', 'Not found');
        return row;
    }

    router.get('/:id/form-scenarios', async (req, res) => {
        const a = await guarded(req, res, 'view');
        if (!a) return undefined;
        const rows = await testing().listFormScenarios(a.id);
        return res.json({ scenarios: rows.map(describeScenario), limits: { max: maxScenarios() } });
    });

    router.get('/:id/form-scenarios/:scenarioId', async (req, res) => {
        const a = await guarded(req, res, 'view');
        if (!a) return undefined;
        const row = await scenarioOf(a, req.params.scenarioId);
        const answers = row.answers || {};
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ scenario: { ...describeScenario(row), answers: { trigger: answers.trigger ?? null, pages: answers.pages || {} } } });
    });

    router.post('/:id/form-scenarios', validate({ body: CreateBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof CreateBody>, import('qs').ParsedQs>} */ req, res) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return undefined;
        await runData.assertTestDataAllowed(a);
        const found = await runData.readableRun(req, res, req.body.fromRunId, 'save its answers');
        if (!found) return undefined;
        if (found.run.automationId !== a.id) throw new HttpError(404, 'run_not_found', 'Not found');
        await runData.assertCapturable(found.run, found.legs);

        const cap = maxScenarios();
        if (cap > 0 && await testing().countFormScenarios(a.id) >= cap) {
            throw new HttpError(409, 'scenario_limit', `An automation keeps at most ${cap} form scenarios. Delete one to save another.`);
        }

        const definition = await store().getVersionDefinition(found.run.automationId, found.run.version) || a.definition;
        const readable = new Set(found.runIds);
        const rows = (await store().getRunStepsForChain(found.root.id)).filter((/** @type {Awaited<ReturnType<typeof import('../../stores/automationStore').getRunStepsForChain>>[number]} */ s) => readable.has(s.runId));
        const answers = answersFromJourney({ definition, rootRun: found.root, steps: rows });
        if (!hasAnswers(answers)) {
            throw new HttpError(422, 'no_form_answers', 'This run holds no form answers to save. Pick a run where somebody filled in a form.');
        }
        const maxBytes = maxScenarioBytes();
        if (maxBytes > 0 && answersSize(answers) > maxBytes) {
            throw new HttpError(413, 'scenario_too_large', 'The answers of this run are too large to save as a scenario.');
        }

        const row = await testing().createFormScenario({
            automationId: a.id, sourceRunId: found.root.id, name: req.body.name, answers, createdBy: sessionUser(req).id,
        });
        return res.status(201).json({ scenario: describeScenario(row) });
    });

    router.put('/:id/form-scenarios/:scenarioId', validate({ body: RenameBody }), async (/** @type {import('express').Request<{ id: string, scenarioId: string }, any, import('zod').infer<typeof RenameBody>, import('qs').ParsedQs>} */ req, res) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return undefined;
        const row = await testing().renameFormScenario(a.id, req.params.scenarioId, req.body.name);
        if (!row) throw new HttpError(404, 'scenario_not_found', 'Not found');
        return res.json({ scenario: describeScenario(row) });
    });

    router.delete('/:id/form-scenarios/:scenarioId', async (req, res) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return undefined;
        if (!await testing().deleteFormScenario(a.id, req.params.scenarioId)) throw new HttpError(404, 'scenario_not_found', 'Not found');
        return res.json({ deleted: true });
    });

    router.post('/:id/form-scenarios/:scenarioId/dry-run', limiter, validate({ body: DryRunBody }), async (/** @type {import('express').Request<{ id: string, scenarioId: string }>} */ req, res) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return undefined;
        const row = await scenarioOf(a, req.params.scenarioId);
        const entered = resolveTriggerStepId(await entryDefinitionOf(a), req.body.triggerStepId);
        if (entered.error) throw new HttpError(400, 'invalid_trigger_step', entered.error);
        const answers = row.answers || {};
        const run = await execute(a, {
            triggerKind: 'dry_run',
            mode: 'dry_run',
            triggerPayload: answers.trigger || null,
            rootStepId: entered.rootStepId,
            startedByUserId: sessionUser(req).id,
            harness: {
                source: { kind: 'scenario', id: row.id },
                formAnswers: { pages: answers.pages || {} },
                aiAnswers: 'live',
            },
        });
        const steps = await store().getRunSteps(run.id);
        return res.json({ run, steps });
    });

    return router;
}

module.exports = { makeFormScenariosRouter, describeScenario };
