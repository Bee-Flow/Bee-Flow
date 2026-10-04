'use strict';

/**
 * automation_* tools — self-scoped to the running automation, simulated outside live
 * mode, and a proposal can only be applied by the automation it belongs to.
 *
 * Run: node --test --test-force-exit integrations/automationEvolutionTools.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { AUTOMATION_EVOLUTION_TOOLS, isAutomationEvolutionTool, executeAutomationEvolutionTool } = require('./automationEvolutionTools');

let calls, rows;
function deps() {
    return {
        svc: {
            validatePlan: (plan) => (Array.isArray(plan) && plan.length ? null : 'plan must be a non-empty array of { tool, args }'),
            async summariseRuns(id, opts) { calls.push(['summary', id, opts]); return { total: 5, failed: 0, failureRate: 0 }; },
            async proposeEvolution(a) { calls.push(['propose', a]); rows.evo1 = { id: 'evo1', automationId: a.automationId, status: 'proposed', canaryRuns: 20 }; return rows.evo1; },
            async applyEvolution(id, o) { calls.push(['apply', id, o]); rows[id].status = 'canary'; rows[id].versionBefore = 3; rows[id].versionAfter = 4; return rows[id]; },
        },
        async getEvolution(id) { return rows[id] || null; },
    };
}
const PLAN = [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'x' } } }];

beforeEach(() => { calls = []; rows = {}; });

test('three tools, automation-only names', () => {
    assert.deepStrictEqual(AUTOMATION_EVOLUTION_TOOLS.map(t => t.function.name), ['automation_runs_summary', 'automation_propose_evolution', 'automation_apply_evolution']);
    assert.ok(isAutomationEvolutionTool('automation_apply_evolution') && !isAutomationEvolutionTool('gmail_read'));
});

test('refuses outside an automation — there is no automation to act on', async () => {
    const r = await executeAutomationEvolutionTool('automation_runs_summary', {}, { userId: 'u1' }, deps());
    assert.match(r.error, /inside a running automation/);
    assert.strictEqual(calls.length, 0);
});

test('summary is keyed off the running automation, not an argument', async () => {
    const r = await executeAutomationEvolutionTool('automation_runs_summary', { days: 14, automationId: 'someone-else' }, { userId: 'u1', automationId: 'a1', autoSend: false }, deps());
    assert.strictEqual(r.total, 5);
    assert.deepStrictEqual(calls[0], ['summary', 'a1', { days: 14 }]);
});

test('propose and apply are simulated outside live mode', async () => {
    const d = deps();
    const p = await executeAutomationEvolutionTool('automation_propose_evolution', { rationale: 'r', expectedEffect: 'e', risk: 'k', plan: PLAN }, { userId: 'u1', automationId: 'a1', autoSend: false }, d);
    assert.strictEqual(p.simulated, true);
    const a = await executeAutomationEvolutionTool('automation_apply_evolution', { evolutionId: 'evo1' }, { userId: 'u1', automationId: 'a1', autoSend: false }, d);
    assert.strictEqual(a.simulated, true);
    assert.strictEqual(calls.length, 0, 'nothing stored, nothing applied');
});

test('live: propose stores for THIS automation; apply refuses another automation\'s proposal', async () => {
    const d = deps();
    const p = await executeAutomationEvolutionTool('automation_propose_evolution', { rationale: 'r', expectedEffect: 'e', risk: 'k', plan: PLAN }, { userId: 'u1', automationId: 'a1', autoSend: true }, d);
    assert.strictEqual(p.evolutionId, 'evo1');
    assert.strictEqual(calls[0][1].automationId, 'a1');

    const foreign = await executeAutomationEvolutionTool('automation_apply_evolution', { evolutionId: 'evo1' }, { userId: 'u1', automationId: 'a2', autoSend: true }, d);
    assert.match(foreign.error, /different automation/);

    const own = await executeAutomationEvolutionTool('automation_apply_evolution', { evolutionId: 'evo1' }, { userId: 'u1', automationId: 'a1', autoSend: true }, d);
    assert.strictEqual(own.status, 'canary');
    assert.strictEqual(own.versionAfter, 4);
});

test('an invalid plan is rejected before anything is stored', async () => {
    const r = await executeAutomationEvolutionTool('automation_propose_evolution', { rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [] }, { userId: 'u1', automationId: 'a1', autoSend: true }, deps());
    assert.match(r.error, /non-empty/);
    assert.strictEqual(calls.length, 0);
});
