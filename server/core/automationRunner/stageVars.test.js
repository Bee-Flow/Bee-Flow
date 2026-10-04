/**
 * stageVars.runVarsFor: the Solution variable overlay a run sees (design 4.2),
 * isManagedAutomation, and the D17 wiring in the runner: a managed automation's test
 * and partial runs execute its LIVE copy, a managed automation without one is
 * refused before a run row exists, and the Solution values reach the vars of
 * the loop-body and layer synthetics.
 *
 * No module is replaced: the stage lookups go through stageVars'
 * configureStageVars seam, the executor and replay seeding of a partial run
 * through partialRuns' configurePartialRuns seam.
 *
 * Run: cd server && node --test core/automationRunner/stageVars.test.js
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { runVarsFor, isManagedAutomation, configureStageVars } = require('./stageVars');
const { automationForRun } = require('./definitionForRun');

function quietLog() {
    const warnings = [];
    return { warnings, warn: (m) => warnings.push(m), info() {}, error() {}, debug() {} };
}

test('the project values are laid over definition.vars', async () => {
    const calls = [];
    const automation = { id: 'a1', projectId: 'p1', definition: { vars: { api_base: 'https://dev.example', keep: 1 } } };
    const vars = await runVarsFor(automation, {}, {
        variableValuesFor: async (projectId) => { calls.push(projectId); return { api_base: 'https://prd.example', limit: 5 }; },
        log: quietLog(),
    });
    assert.deepStrictEqual(vars, { api_base: 'https://prd.example', keep: 1, limit: 5 });
    assert.deepStrictEqual(calls, ['p1']);
    assert.deepStrictEqual(automation.definition.vars, { api_base: 'https://dev.example', keep: 1 }, 'the definition is not mutated');
});

test('opts.definition overrides the automation definition (a partial run)', async () => {
    const vars = await runVarsFor({ projectId: 'p1', definition: { vars: { a: 1 } } }, { definition: { vars: { b: 2 } } }, {
        variableValuesFor: async () => ({ c: 3 }),
    });
    assert.deepStrictEqual(vars, { b: 2, c: 3 });
});

test('no project gives definition.vars, without reading the store', async () => {
    let called = false;
    const deps = { variableValuesFor: async () => { called = true; return { x: 1 }; } };
    const definition = { vars: { only: 'mine' } };
    assert.deepStrictEqual(await runVarsFor({ projectId: null, definition }, {}, deps), { only: 'mine' });
    assert.deepStrictEqual(await runVarsFor({ definition }, {}, deps), { only: 'mine' });
    assert.deepStrictEqual(await runVarsFor({ definition: {} }, {}, deps), {});
    assert.deepStrictEqual(await runVarsFor(null, {}, deps), {});
    assert.strictEqual(called, false);
});

test('a project with no values gives definition.vars', async () => {
    const definition = { vars: { k: 'v' } };
    assert.deepStrictEqual(await runVarsFor({ projectId: 'p1', definition }, {}, { variableValuesFor: async () => ({}) }), { k: 'v' });
});

test('a store failure falls back to definition.vars and logs a warning', async () => {
    const log = quietLog();
    const vars = await runVarsFor({ id: 'a9', projectId: 'p1', definition: { vars: { k: 'v' } } }, {}, {
        variableValuesFor: async () => { throw new Error('db down'); },
        log,
    });
    assert.deepStrictEqual(vars, { k: 'v' });
    assert.strictEqual(log.warnings.length, 1);
    assert.match(log.warnings[0], /p1/);
    assert.match(log.warnings[0], /db down/);
});

test('a synchronous throw falls back too', async () => {
    const vars = await runVarsFor({ projectId: 'p1', definition: {} }, {}, {
        variableValuesFor: () => { throw new Error('boom'); },
        log: quietLog(),
    });
    assert.deepStrictEqual(vars, {});
});

// ── isManagedAutomation ─────────────────────────────────────────────────────

test('isManagedAutomation: only an automation with a project is looked up; a failing lookup rejects', async () => {
    const asked = [];
    const deps = { managedInfo: async (projectId) => { asked.push(projectId); return projectId === 'p-uat' ? { stage: 'uat' } : null; } };
    assert.strictEqual(await isManagedAutomation({ kind: 'automation', projectId: 'p-uat' }, deps), true);
    assert.strictEqual(await isManagedAutomation({ projectId: 'p-dev' }, deps), false);
    assert.strictEqual(await isManagedAutomation({ kind: 'automation', projectId: null }, deps), false);
    assert.strictEqual(await isManagedAutomation({ kind: 'block', projectId: 'p-uat' }, deps), false);
    assert.strictEqual(await isManagedAutomation(null, deps), false);
    assert.deepStrictEqual(asked, ['p-uat', 'p-dev']);
    await assert.rejects(() => isManagedAutomation({ projectId: 'p1' }, { managedInfo: async () => { throw new Error('db down'); } }), /db down/);
});

// ── The runner wiring (D17, design 4.2) ──────────────────────────────────

const LIVE = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 's1', type: 'set', values: { which: 'LIVE' } },
        { id: 'lp1', type: 'loop', overRef: 'vars.items', itemVar: 'item', body: [{ id: 'b1', type: 'set', values: { item: '{{loop.item}}', which: 'LIVE' } }] },
        { id: 'cl1', type: 'call_layer', layerKey: 'L1' },
    ],
    edges: [{ from: 't1', to: 's1' }, { from: 's1', to: 'lp1' }, { from: 'lp1', to: 'cl1' }],
    layers: { L1: { trigger: { id: 'li', type: 'trigger', kind: 'layer_input' }, steps: [{ id: 'ls1', type: 'set', values: { which: 'LIVE' } }], edges: [{ from: 'li', to: 'ls1' }] } },
    vars: { items: ['own-item'], own: 'live' },
    runPolicy: { retry: { max: 1 } },
};
const INCOMING = JSON.parse(JSON.stringify(LIVE).replace(/LIVE/g, 'INCOMING'));
INCOMING.runPolicy = { retry: { max: 9 } };

/** An automation as the store returns it: the live copy rides along non-enumerable. */
function storedAutomation({ live = true, projectId = 'p-uat' } = {}) {
    const row = { id: 'r1', kind: 'automation', userId: 'u1', projectId, version: 7, liveVersion: live ? 5 : null, definition: INCOMING };
    Object.defineProperty(row, 'liveDefinition', { value: live ? LIVE : null, enumerable: false, writable: true, configurable: true });
    return row;
}

const SOLUTION_VALUES = { items: ['stage-item-1', 'stage-item-2'], api_base: 'https://uat.example' };
let restores = [];
afterEach(() => { for (const r of restores.reverse()) r(); restores = []; });

/** Stage lookups for every run in a test: `managed` decides the stage. */
function stage({ managed = true } = {}) {
    const seen = { values: 0 };
    restores.push(configureStageVars({
        managedInfo: async () => (managed ? { stage: 'uat' } : null),
        variableValuesFor: async () => { seen.values++; return SOLUTION_VALUES; },
        log: quietLog(),
    }));
    return seen;
}

/** A partial run whose executor and replay seeding are captured, not run. */
function capturePartial() {
    const { runPartial, configurePartialRuns } = require('./partialRuns');
    const calls = { exec: [], seed: [] };
    restores.push(configurePartialRuns({
        executeAutomation: async (automation, opts) => { calls.exec.push({ automation, opts }); return { id: 'run-x', status: 'success' }; },
        seedReplayState: async (automationId, version) => {
            calls.seed.push({ automationId, version });
            return { replayState: {}, staleFrom: {}, runsWindow: [], stepsByRun: new Map(), parentRunId: null };
        },
    }));
    return { runPartial, calls };
}

const refusedAsNotDeployed = (err) => err.status === 409 && err.code === 'managed_part_not_deployed' && err.errorClass === 'managed_part_not_deployed';

test('executeAutomation refuses a managed test run without a live copy, before a run row exists', async () => {
    const seen = stage();
    const { executeAutomation } = require('./execution');
    for (const opts of [{ mode: 'live', triggerKind: 'manual', isTest: true }, { mode: 'dry_run', triggerKind: 'dry_run' }, { mode: 'live', triggerKind: 'manual_step' }]) {
        let created = 0;
        await assert.rejects(
            () => executeAutomation(storedAutomation({ live: false }), { ...opts, onRunCreated: () => { created++; } }),
            refusedAsNotDeployed, JSON.stringify(opts));
        assert.strictEqual(created, 0, 'no run row');
    }
    assert.strictEqual(seen.values, 0, 'refused before the run state is built');
});

test('a managed partial run executes the LIVE copy with the live settings', async () => {
    stage();
    const { runPartial, calls } = capturePartial();
    await runPartial(storedAutomation(), 's1', { mode: 'upTo', triggerKind: 'manual_step' });
    const { automation } = calls.exec[0];
    assert.strictEqual(automation.version, 5, 'the live version is recorded');
    assert.strictEqual(automation.workingVersion, 7);
    assert.strictEqual(automation.runsLiveVersion, true);
    assert.deepStrictEqual(automation.definition.steps[0].values, { which: 'LIVE' });
    assert.deepStrictEqual(automation.definition.runPolicy, { retry: { max: 1 } }, 'live settings, not the incoming release');
    // executeAutomation's own managed selection keeps what the partial run chose.
    assert.strictEqual(automationForRun(automation, { mode: 'live', triggerKind: 'manual_step', managed: true }).definition, automation.definition);

    await runPartial(storedAutomation(), 's1', { mode: 'only', triggerKind: 'manual_step' });
    assert.deepStrictEqual(calls.seed.at(-1), { automationId: 'r1', version: 5 }, 'replay seeded from the live version');
    assert.deepStrictEqual(calls.exec.at(-1).automation.definition.steps[0].values, { which: 'LIVE' });
});

test('a managed partial run without a live copy is refused before anything runs', async () => {
    stage();
    const { runPartial, calls } = capturePartial();
    for (const stepId of ['s1', 'lp1/b1', 'ls1']) {
        await assert.rejects(() => runPartial(storedAutomation({ live: false }), stepId, { mode: 'only', triggerKind: 'manual_step' }), refusedAsNotDeployed, stepId);
    }
    assert.strictEqual(calls.exec.length, 0);
    assert.strictEqual(calls.seed.length, 0);
});

test('the Solution values reach the loop-body synthetic: its vars and the iteration item', async () => {
    stage();
    const { runPartial, calls } = capturePartial();
    await runPartial(storedAutomation(), 'lp1/b1', { mode: 'only', triggerKind: 'manual_step' });
    const { automation, opts } = calls.exec[0];
    assert.deepStrictEqual(automation.definition.vars, { items: ['stage-item-1', 'stage-item-2'], own: 'live', api_base: 'https://uat.example' });
    assert.strictEqual(opts.loopVars.item, 'stage-item-1', 'the loop iterates the stage value');
    assert.deepStrictEqual(automation.definition.steps[0].values.which, 'LIVE', 'the live body');
});

test('the Solution values reach the layer synthetic', async () => {
    stage();
    const { runPartial, calls } = capturePartial();
    await runPartial(storedAutomation(), 'ls1', { mode: 'only', triggerKind: 'manual_step' });
    const { automation } = calls.exec[0];
    assert.deepStrictEqual(automation.definition.vars, { items: ['stage-item-1', 'stage-item-2'], own: 'live', api_base: 'https://uat.example' });
    assert.deepStrictEqual(automation.definition.steps[0].values, { which: 'LIVE' }, 'the live layer');
});

test('an unmanaged partial run is unchanged: the row goes to executeAutomation as given', async () => {
    stage({ managed: false });
    const { runPartial, calls } = capturePartial();
    const row = storedAutomation({ projectId: 'p-dev' });
    await runPartial(row, 's1', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.strictEqual(calls.exec[0].automation, row);
    await runPartial(row, 'lp1/b1', { mode: 'only', triggerKind: 'manual_step' });
    assert.deepStrictEqual(calls.exec[1].automation.definition.steps[0].values.which, 'INCOMING', 'the working copy, as before');
});
