'use strict';

/**
 * automation/evolution.js — propose → apply (new version + canary) → judge.
 *
 * Deps are injected: an in-memory store, a builder stub that edits the copy,
 * a validator, a notification sink. What is asserted is the contract that
 * keeps self-modification safe: the plan vocabulary, apply on a COPY that is
 * validated before it is saved, the baseline captured at apply time, and the
 * canary verdict (kept / rolled back to the exact previous version).
 *
 * Run: node --test --test-force-exit automation/evolution.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const evolution = require('./evolution');

let automations, evolutions, versions, notifications, runSummaries, validateResult, nowMs;

function makeDeps() {
    return {
        store: {
            async getAutomation(id) { return automations[id] || null; },
            async updateAutomation(id, updates, userId) {
                const a = automations[id];
                if (updates.definition !== undefined) { a.version += 1; a.definition = updates.definition; versions[`${id}:${a.version}`] = JSON.parse(JSON.stringify(updates.definition)); }
                if (updates.title) a.title = updates.title;
                a.updatedBy = userId;
                return { ...a };
            },
            async getVersionDefinition(id, v) { return versions[`${id}:${v}`] || null; },
            async createEvolution(row) { const id = `evo${Object.keys(evolutions).length + 1}`; evolutions[id] = { id, status: 'proposed', canaryRuns: row.canaryRuns || 20, ...row }; return { ...evolutions[id] }; },
            async getEvolution(id) { return evolutions[id] ? { ...evolutions[id] } : null; },
            async updateEvolution(id, patch) { Object.assign(evolutions[id], patch); return { ...evolutions[id] }; },
            async listCanaryEvolutions() { return Object.values(evolutions).filter(e => e.status === 'canary').map(e => ({ ...e })); },
            async runOutcomeSummary(id, opts) { const f = runSummaries[id]; return typeof f === 'function' ? f(opts) : (f || { total: 0, failed: 0, failureRate: 0, byStatus: {}, byErrorClass: {}, handledErrors: 0, avgDurationMs: null, byRoot: [] }); },
        },
        async applyToolCall(tool, args, draftWrap) {
            if (tool === 'builder_update_step') {
                const s = draftWrap.def.steps.find(x => x.id === args.stepId);
                if (!s) return { error: `no step ${args.stepId}` };
                Object.assign(s, args.patch);
                return { updated: s };
            }
            if (tool === 'builder_set_metadata') { draftWrap.title = args.title; return { ok: true }; }
            return { error: `stub cannot ${tool}` };
        },
        validateDefinition() { return validateResult; },
        getDeliverableEvents() { return []; },
        async notify(n) { notifications.push(n); },
        now() { return new Date(nowMs); },
    };
}

beforeEach(() => {
    automations = { a1: { id: 'a1', userId: 'u1', title: 'Assistant', description: '', version: 3, definition: { steps: [{ id: 'ai_1', type: 'ai_step', prompt: 'old prompt' }] } } };
    evolutions = {};
    versions = { 'a1:3': JSON.parse(JSON.stringify(automations.a1.definition)) };
    notifications = [];
    runSummaries = { a1: { total: 40, failed: 2, failureRate: 0.05, byStatus: { success: 38, error: 2 }, byErrorClass: {}, handledErrors: 1, avgDurationMs: 900, byRoot: [] } };
    validateResult = { ok: true, errors: [] };
    nowMs = Date.parse('2026-09-04T08:00:00Z');
});

test('validatePlan enforces the narrow vocabulary and the size cap', () => {
    assert.match(evolution.validatePlan([{ tool: 'builder_remove_step', args: { stepId: 'x' } }]), /not allowed/);
    assert.match(evolution.validatePlan([]), /non-empty/);
    assert.strictEqual(evolution.validatePlan([{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: {} } }]), null);
    assert.match(evolution.validatePlan(new Array(13).fill({ tool: 'builder_add_note', args: {} })), /maximum is 12/);
});

test('propose stores a row with the plan; nothing is applied', async () => {
    const deps = makeDeps();
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'new prompt' } } }] }, deps);
    assert.strictEqual(row.status, 'proposed');
    assert.strictEqual(automations.a1.definition.steps[0].prompt, 'old prompt');
    assert.strictEqual(automations.a1.version, 3);
});

test('apply runs the plan on a copy, validates, saves a new version, captures the baseline and starts the canary', async () => {
    const deps = makeDeps();
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'Shorter prompt', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'new prompt' } } }] }, deps);
    const out = await evolution.applyEvolution(row.id, { userId: 'u1' }, deps);
    assert.strictEqual(out.status, 'canary');
    assert.strictEqual(out.versionBefore, 3);
    assert.strictEqual(out.versionAfter, 4);
    assert.strictEqual(out.baseline.failureRate, 0.05);
    assert.strictEqual(automations.a1.definition.steps[0].prompt, 'new prompt');
    assert.strictEqual(versions['a1:3'].steps[0].prompt, 'old prompt', 'the previous version is untouched');
    assert.strictEqual(notifications.length, 1);
    assert.match(notifications[0].title, /v3 → v4/);
});

test('a plan that breaks validation is not saved and the row ends failed', async () => {
    const deps = makeDeps();
    validateResult = { ok: false, errors: [{ code: 'binding.unknown_step', path: 'steps[0]', message: 'nope' }] };
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'x' } } }] }, deps);
    const out = await evolution.applyEvolution(row.id, { userId: 'u1' }, deps);
    assert.strictEqual(out.status, 'failed');
    assert.match(out.error, /definition invalid after the plan/);
    assert.strictEqual(automations.a1.version, 3, 'nothing saved');
    assert.strictEqual(automations.a1.definition.steps[0].prompt, 'old prompt');
});

test('a builder call that fails ends the row failed without saving', async () => {
    const deps = makeDeps();
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'missing', patch: {} } }] }, deps);
    const out = await evolution.applyEvolution(row.id, { userId: 'u1' }, deps);
    assert.strictEqual(out.status, 'failed');
    assert.match(out.error, /plan\[0\] builder_update_step: no step missing/);
    assert.strictEqual(automations.a1.version, 3);
});

test('someone other than the owner cannot apply', async () => {
    const deps = makeDeps();
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'x' } } }] }, deps);
    const out = await evolution.applyEvolution(row.id, { userId: 'intruder' }, deps);
    assert.strictEqual(out.status, 'failed');
    assert.match(out.error, /Only the automation owner/);
});

async function applied(deps) {
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'new prompt' } } }], canaryRuns: 10 }, deps);
    return evolution.applyEvolution(row.id, { userId: 'u1' }, deps);
}

test('a canary with too few runs and little age is left alone', async () => {
    const deps = makeDeps();
    const row = await applied(deps);
    runSummaries.a1 = (opts) => (opts.minVersion === 4 ? { total: 3, failed: 3, failureRate: 1 } : { total: 40, failed: 2, failureRate: 0.05 });
    nowMs += 3600 * 1000;
    const verdicts = await evolution.evaluateCanaries(deps);
    assert.deepStrictEqual(verdicts, []);
    assert.strictEqual((await deps.store.getEvolution(row.id)).status, 'canary');
});

test('a regression after enough runs rolls back to the exact previous version', async () => {
    const deps = makeDeps();
    const row = await applied(deps);
    runSummaries.a1 = (opts) => (opts.minVersion === 4 ? { total: 10, failed: 4, failureRate: 0.4 } : { total: 40, failed: 2, failureRate: 0.05 });
    nowMs += 3600 * 1000;
    const verdicts = await evolution.evaluateCanaries(deps);
    assert.deepStrictEqual(verdicts, [{ id: row.id, verdict: 'rolled_back' }]);
    const after = await deps.store.getEvolution(row.id);
    assert.strictEqual(after.status, 'rolled_back');
    assert.strictEqual(after.canary.rolledBack, true);
    assert.strictEqual(automations.a1.definition.steps[0].prompt, 'old prompt', 'definition restored from the version-before snapshot');
    assert.strictEqual(automations.a1.version, 5, 'the rollback is itself a new version, never a rewrite of history');
    assert.match(notifications.at(-1).title, /rolled back to v3/);
});

test('a healthy canary is kept once it has seen its runs', async () => {
    const deps = makeDeps();
    const row = await applied(deps);
    runSummaries.a1 = (opts) => (opts.minVersion === 4 ? { total: 12, failed: 1, failureRate: 0.083 } : { total: 40, failed: 2, failureRate: 0.05 });
    nowMs += 3600 * 1000;
    const verdicts = await evolution.evaluateCanaries(deps);
    assert.deepStrictEqual(verdicts, [{ id: row.id, verdict: 'kept' }]);
    assert.strictEqual((await deps.store.getEvolution(row.id)).status, 'kept');
    assert.strictEqual(automations.a1.definition.steps[0].prompt, 'new prompt');
});

test('an old canary is judged on age even with few runs', async () => {
    const deps = makeDeps();
    const row = await applied(deps);
    runSummaries.a1 = (opts) => (opts.minVersion === 4 ? { total: 2, failed: 0, failureRate: 0 } : { total: 40, failed: 2, failureRate: 0.05 });
    nowMs += 8 * 24 * 3600 * 1000;
    const verdicts = await evolution.evaluateCanaries(deps);
    assert.deepStrictEqual(verdicts, [{ id: row.id, verdict: 'kept' }]);
});

test('apply refuses while the working copy holds unpublished changes (handoff 5 live split)', async () => {
    const deps = makeDeps();
    Object.assign(automations.a1, { liveVersion: 2, pendingChanges: 1 });
    const row = await evolution.proposeEvolution({ automationId: 'a1', userId: 'u1', rationale: 'r', expectedEffect: 'e', risk: 'k', plan: [{ tool: 'builder_update_step', args: { stepId: 'ai_1', patch: { prompt: 'new prompt' } } }] }, deps);
    const out = await evolution.applyEvolution(row.id, { userId: 'u1' }, deps);
    assert.strictEqual(out.status, 'failed');
    assert.match(out.error, /not live yet/);
    assert.strictEqual(automations.a1.version, 3, 'nothing was saved');
    assert.strictEqual(automations.a1.definition.steps[0].prompt, 'old prompt');
});
