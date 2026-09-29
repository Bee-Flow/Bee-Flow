'use strict';

/**
 * routine_* tools — self-scoped to the running routine, simulated outside live
 * mode, and a proposal can only be applied by the routine it belongs to.
 *
 * Run: node --test --test-force-exit integrations/routineEvolutionTools.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { ROUTINE_EVOLUTION_TOOLS, isRoutineEvolutionTool, executeRoutineEvolutionTool } = require('./routineEvolutionTools');

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

test('three tools, routine-only names', () => {
    assert.deepStrictEqual(ROUTINE_EVOLUTION_TOOLS.map(t => t.function.name), ['routine_runs_summary', 'routine_propose_evolution', 'routine_apply_evolution']);
    assert.ok(isRoutineEvolutionTool('routine_apply_evolution') && !isRoutineEvolutionTool('gmail_read'));
});

test('refuses outside a routine — there is no automation to act on', async () => {
    const r = await executeRoutineEvolutionTool('routine_runs_summary', {}, { userId: 'u1' }, deps());
    assert.match(r.error, /inside a running routine/);
    assert.strictEqual(calls.length, 0);
});

test('summary is keyed off the running routine, not an argument', async () => {
    const r = await executeRoutineEvolutionTool('routine_runs_summary', { days: 14, automationId: 'someone-else' }, { userId: 'u1', automationId: 'a1', autoSend: false }, deps());
    assert.strictEqual(r.total, 5);
    assert.deepStrictEqual(calls[0], ['summary', 'a1', { days: 14 }]);
});

test('propose and apply are simulated outside live mode', async () => {
    const d = deps();
    const p = await executeRoutineEvolutionTool('routine_propose_evolution', { rationale: 'r', expectedEffect: 'e', risk: 'k', plan: PLAN }, { userId: 'u1', automationId: 'a1', autoSend: false }, d);
    assert.strictEqual(p.simulated, true);
    const a = await executeRoutineEvolutionTool('routine_apply_evolution', { evolutionId: 'evo1' }, { userId: 'u1', automationId: 'a1', autoSend: false }, d);
    assert.strictEqual(a.simulated, true);
    assert.strictEqual(calls.length, 0, 'nothing stored, nothing applied');
});

test('live: propose stores for THIS routine; apply refuses another routine\'s proposal', async () => {
    const d = deps();
    const p = await executeRoutineEvolutionTool('routine_propose_evolution', { rationale: 'r', expectedEffect: 'e', risk: 'k', plan: PLAN }, { userId: 'u1', automationId: 'a1', autoSend: true }, d);
    assert.strictEqual(p.evolutionId, 'evo1');
    assert.strictEqual(calls[0][1].automationId, 'a1');

    const foreign = await executeRoutineEvolutionTool('routine_apply_evolution', { evolutionId: 'evo1' }, { userId: 'u1', automationId: 'a2', autoSend: true }, d);
    assert.match(foreign.error, /different routine/);

    const own = await executeRoutineEvolutionTool('routine_apply_evolution', { evolutionId: 'evo1' }, { userId: 'u1', automationId: 'a1', autoSend: true }, d);
    assert.strictEqual(own.status, 'canary');
    assert.strictEqual(own.versionAfter, 4);
});

test('an invalid plan is rejected before anything is stored', async () => {
    const r = await executeRoutineEvolutionTool('routine_propose_evolution', { rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [] }, { userId: 'u1', automationId: 'a1', autoSend: true }, deps());
    assert.match(r.error, /non-empty/);
    assert.strictEqual(calls.length, 0);
});
