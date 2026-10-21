// @typecheck
'use strict';
/**
 * Form scenarios over MCP: list the saved answer sets of an automation and dry
 * run the automation with one of them (routes/automation/formScenarios.js is
 * the product side).
 *
 *   automations_list_form_scenarios  {automationId}
 *       scenarios: name, which pages they answer (field COUNTS), how many
 *       answers were not kept, when saved. No answer values.
 *   automations_dry_run_form_scenario {automationId, scenarioId, triggerStepId?}
 *       a dry run that plays every form page from the scenario. The result is
 *       ALWAYS shape-only: per step the type, status, duration, a value-free
 *       error line and the SHAPE of its output. A value is read with
 *       automations_get_step_output, where the raw policy and the audit row live.
 *
 * Scenarios are CAPTURED IN THE PRODUCT from a real run, never written over
 * MCP: an agent cannot put data into one. Scope is the one the run reads use:
 * the automation must be the token user's own (loadOwnedAutomation), anything
 * else answers 404. Nothing here throws; a refusal is `{ error, code }`.
 *
 * Collaborators are injected (makeFormScenarioTools) so tests hand in fakes;
 * nothing is required from the database layer at load time.
 */

const { HttpError } = require('../core/http/errors');
const { makeToolCall } = require('./mcpToolCall');
const { makeAccess, text } = require('./mcpRunReadAccess');
const { caps, STEP_ERROR_CHARS, MAX_ID_CHARS, envCap } = require('./mcpRunReadCaps');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { describePayload } = require('./mcpRunReadShape');
const { valueFreeErrorLine } = require('./mcpRunReadScrub');

const SHAPE_NOTE = 'Shapes only. Read a value with automations_get_step_output.';

/** @type {any[]} */
const FORM_SCENARIO_TOOLS = [
    {
        name: 'automations_list_form_scenarios',
        description: 'List the form scenarios of one automation: saved sets of answers to its forms, captured in the product from a real run. Per scenario: scenarioId, name, whether it answers the form trigger, the form pages it answers (stepId and fieldCount), how many answers were not kept (files and records picked from an app), createdAt. Never the answers themselves. Read-only.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'automations_dry_run_form_scenario',
        description: 'Dry run the automation with a form scenario: every form page the scenario has answers for is filled from it, nothing pauses and nothing is sent. Returns the run id and status and, per step, the type, status, duration, a scrubbed error and the SHAPE of the output (keys, types, list lengths). Never values: read one with automations_get_step_output. Use it to check that a change to the automation still works for realistic form answers. Needs a scenario from automations_list_form_scenarios.',
        parameters: {
            type: 'object',
            properties: {
                scenarioId: { type: 'string', description: 'The scenario (id from automations_list_form_scenarios).' },
                triggerStepId: { type: 'string', description: 'Optional: enter through this additional trigger instead of the primary one.' },
            },
            required: ['scenarioId'],
        },
    },
];

const FORM_SCENARIO_TOOL_NAMES = new Set(FORM_SCENARIO_TOOLS.map((t) => t.name));

/** A short section for the guide automations_get_guide returns. */
function guideSection() {
    return [
        '## Form scenarios (dry run)',
        '',
        'A form scenario is a saved set of answers to the forms of one automation. People save it in the product, from a real run: you cannot create or change one over MCP. It lets you try a change against realistic answers without anybody typing them again.',
        '- automations_list_form_scenarios { automationId }: the scenarios, with the pages each one answers (field counts only).',
        '- automations_dry_run_form_scenario { automationId, scenarioId, triggerStepId? }: a dry run that plays the form pages from the scenario. Nothing is sent or written outside the run.',
        'Results are shapes only: per step the status, duration, a scrubbed error and the keys, types and list lengths of the output. Use automations_get_step_output { runId, stepId } to look closer; raw values stay behind its organisation setting and audit row.',
        'A scenario can stop fitting after the form changed: the step then fails with scenario_answers_invalid and names the questions that no longer pass. Fix the automation, or ask for a new scenario to be saved from a fresh run.',
    ].join('\n');
}

const idOf = (v, what, hint) => {
    const id = text(v);
    if (!id || id.length > MAX_ID_CHARS) throw new HttpError(400, `invalid_${what}`, `${what} is required (${hint}).`);
    return id;
};

/**
 * @param {Parameters<typeof makeAccess>[0] & {
 *   access?: ReturnType<typeof makeAccess>,
 *   testingStore?: any,
 *   executeAutomation?: Function,
 *   allowRun?: (userId: string) => Promise<boolean>,
 *   entry?: { entryDefinitionOf: Function, resolveTriggerStepId: Function },
 * }} [overrides]
 */
function makeFormScenarioTools(overrides = {}) {
    const access = overrides.access || makeAccess(overrides);
    const testing = () => overrides.testingStore || require('../stores/automationTestingStore');
    const execute = (...args) => (overrides.executeAutomation || require('../core/automationRunner').executeAutomation)(...args);
    const entry = () => overrides.entry || require('../core/automationRunner/entryPoint');

    // A scenario dry run executes the automation (live reads, live model calls),
    // so it spends the same per-user budget as the product's run button:
    // AUTOMATION_RUN_TRIGGER_RPM (default 30 a minute, 0 = unlimited).
    let limiter = null;
    const allowRun = overrides.allowRun || (async (userId) => {
        const rpm = envCap('AUTOMATION_RUN_TRIGGER_RPM', 30);
        if (rpm <= 0) return true;
        if (!limiter || limiter.rpm !== rpm) limiter = { rpm, check: perUserRateLimit({ windowMs: 60_000, max: rpm }).check };
        const res = { set() { return res; }, status() { return res; }, json() { return res; } };
        return limiter.check({ session: { user: { id: userId } } }, res);
    });

    async function listScenarios(userId, args) {
        const automationId = idOf(args.automationId, 'automationId', 'an id from automations_list');
        const { automation } = await access.loadOwnedAutomation(automationId, userId);
        const rows = await testing().listFormScenarios(automation.id);
        return {
            scenarios: rows.map((r) => ({
                scenarioId: r.id,
                name: r.name,
                hasTriggerAnswers: !!r.hasTriggerAnswers,
                pages: (r.pages || []).map((p) => ({ stepId: p.stepId, fieldCount: p.fieldCount })),
                skippedCount: Array.isArray(r.skipped) ? r.skipped.length : 0,
                createdAt: r.createdAt,
            })),
        };
    }

    async function dryRunScenario(userId, args) {
        const automationId = idOf(args.automationId, 'automationId', 'an id from automations_list');
        const scenarioId = idOf(args.scenarioId, 'scenarioId', 'an id from automations_list_form_scenarios');
        const triggerStepId = args.triggerStepId == null ? null : text(args.triggerStepId).slice(0, MAX_ID_CHARS) || null;
        const { automation } = await access.loadOwnedAutomation(automationId, userId);
        const scenario = await testing().getFormScenario(automation.id, scenarioId);
        if (!scenario) throw new HttpError(404, 'scenario_not_found', 'Scenario not found for this automation. Call automations_list_form_scenarios for its scenarios.');
        const entered = entry().resolveTriggerStepId(await entry().entryDefinitionOf(automation), triggerStepId);
        if (entered.error) throw new HttpError(400, 'invalid_trigger_step', entered.error);

        if (!await allowRun(userId)) {
            throw new HttpError(429, 'rate_limited', 'Too many dry runs in the last minute. Wait a moment and try again.');
        }
        const answers = scenario.answers || {};
        const run = await execute(automation, {
            triggerKind: 'dry_run',
            mode: 'dry_run',
            triggerPayload: answers.trigger || null,
            rootStepId: entered.rootStepId,
            startedByUserId: userId,
            harness: {
                source: { kind: 'scenario', id: scenario.id },
                formAnswers: { pages: answers.pages || {} },
                aiAnswers: 'live',
            },
        });
        const rows = await access.store().getRunSteps(run.id);
        const c = caps();
        const limits = { keys: c.keys, nodes: c.nodes };
        return {
            runId: run.id,
            status: run.status,
            steps: (rows || []).map((s) => ({
                stepId: s.stepId,
                stepType: s.stepType,
                status: s.status,
                durationMs: s.startedAt && s.finishedAt ? Math.max(0, Date.parse(s.finishedAt) - Date.parse(s.startedAt)) : null,
                error: valueFreeErrorLine(s.error, s.errorClass, STEP_ERROR_CHARS),
                output: describePayload(s.output, limits),
            })),
            note: SHAPE_NOTE,
        };
    }

    const handlers = {
        automations_list_form_scenarios: listScenarios,
        automations_dry_run_form_scenario: dryRunScenario,
    };

    const call = makeToolCall(handlers);

    return { call };
}

const defaultTools = makeFormScenarioTools();

module.exports = {
    FORM_SCENARIO_TOOLS,
    FORM_SCENARIO_TOOL_NAMES,
    callFormScenarioTool: defaultTools.call,
    guideSection,
    makeFormScenarioTools,
};
