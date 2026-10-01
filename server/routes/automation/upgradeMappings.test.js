/**
 * routes/automation/upgradeMappings.js — "Koppelingen bijwerken", over a real
 * Express app with the store and the access guard injected (no module
 * mocking). The upgrade itself is the real one (automation/mappingUpgrade.js
 * over shared/mapping upgradeDefinition), reading its evidence from the fake
 * store's runs.
 *
 * Proven:
 *   - the dry run reports and writes nothing; the report holds labels, never
 *     a value from a run;
 *   - a binding whose value the last run shows would change is skipped, and
 *     stays exactly as stored after the apply; the rest is upgraded and
 *     saved as one new version described as such; without data nothing is;
 *   - the last run is the evidence: dry runs and failed rows are not, the
 *     newest row per step wins, pinned outputs count as a sample;
 *   - the gate is PUT /:id's: edit or owner; view and run are refused, an
 *     unknown routine is a 404; a stale preview version is a 409; nothing to
 *     change writes nothing; a bad query or body is a 400.
 *
 * Run: cd server && node --test routes/automation/upgradeMappings.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeUpgradeMappingsRouter } = require('./upgradeMappings');
const { serve } = require('../../core/http/routeHarness');
const { accessByRole } = require('./testing/accessByRole');
const { createResolver } = require('../../shared/mapping/index.mjs');
const { evaluate } = require('../../automation/expr');
const { recentRunStates, sampleState } = require('../../automation/mappingUpgrade');

const ref = (path) => ({ kind: 'ref', path });
const expr = (value) => ({ kind: 'expr', value });

function definition() {
    return {
        trigger: { id: 't', type: 'trigger', kind: 'webhook' },
        steps: [
            { id: 'get', type: 'integration_action', tool: 'shop_orders', label: 'Orders ophalen', inputs: {} },
            {
                id: 'mail', type: 'integration_action', tool: 'gmail_send', label: 'Mail klant',
                inputs: {
                    to: ref('trigger.output.Klant["E-mail adres"]'),
                    first: ref('steps.get.output.orders[0].id'),
                    // An expr stays a Formula, even where the run agrees.
                    count: expr('count(steps.get.output.orders)'),
                    // A key on a list: the legacy walker reads nothing, a pick
                    // would read the first order's id. The run shows it.
                    sku: ref('steps.get.output.orders.id'),
                    body: expr('upper(trigger.output.Klant.naam)'),
                },
            },
        ],
        edges: [{ from: 't', to: 'get' }, { from: 'get', to: 'mail' }],
    };
}

const PAYLOAD = { Klant: { naam: 'Anna', 'E-mail adres': 'anna@voorbeeld.nl' } };
const ORDERS = { orders: [{ id: 'A-100' }, { id: 'A-101' }] };

let automations;
let runs;
let stepRows;
let calls;

function fakeStore() {
    return {
        async getAutomation(id) { return automations[id] ? structuredClone(automations[id]) : null; },
        async updateAutomation(id, updates, userId, opts) {
            calls.update.push({ id, updates, userId, opts });
            automations[id] = { ...automations[id], ...updates, version: automations[id].version + 1 };
            return structuredClone(automations[id]);
        },
        async getRunsForAutomation(id, opts) { calls.runs.push([id, opts]); return runs.filter(r => r.automationId === id); },
        async getRunSteps(runId) { return stepRows.filter(r => r.runId === runId); },
    };
}

const access = accessByRole({ owner: 'owner', ed: 'edit', vic: 'view', ron: 'run' });
let api;

beforeEach(() => {
    calls = { update: [], runs: [] };
    automations = {
        a1: { id: 'a1', userId: 'owner', kind: 'automation', title: 'Orders', definition: definition(), version: 4 },
        bare: { id: 'bare', userId: 'owner', title: 'Empty', definition: { trigger: { kind: 'manual' } }, version: 1 },
        lit: { id: 'lit', userId: 'owner', title: 'Literals', definition: { trigger: { kind: 'manual' }, steps: [{ id: 's', type: 'integration_action', inputs: { a: { kind: 'literal', value: 1 } } }] }, version: 1 },
    };
    // Newest first, as the store answers.
    runs = [
        { id: 'r3', automationId: 'a1', mode: 'dry_run', triggerKind: 'webhook', triggerPayload: { Klant: { 'E-mail adres': 'fake@example.com' } }, startedAt: '2026-10-01T10:00:00Z' },
        { id: 'r2', automationId: 'a1', mode: 'live', triggerKind: 'webhook', triggerPayload: PAYLOAD, startedAt: '2026-10-01T09:00:00Z' },
        { id: 'r1', automationId: 'a1', mode: 'live', triggerKind: 'webhook', triggerPayload: { Klant: {} }, startedAt: '2026-09-30T09:00:00Z' },
    ];
    stepRows = [
        { runId: 'r3', stepId: 'get', status: 'success', output: { orders: 'synthesised' } },
        { runId: 'r2', stepId: 'get', status: 'success', output: ORDERS },
        { runId: 'r2', stepId: 'mail', status: 'error', output: null },
        { runId: 'r1', stepId: 'mail', status: 'success', output: { sent: true } },
        { runId: 'r2', stepId: 'cl1/out', parentStepId: 'cl1', status: 'success', output: { x: 1 } },
    ];
});

before(() => {
    api = serve('/', makeUpgradeMappingsRouter({ store: fakeStore(), access }));
});
after(() => api.close());

const call = (path, body, user = 'owner') => api.call('POST', path, { body, user: { id: user } });

test('dry run: a report of labels, nothing written', async () => {
    const { status, body } = await call('/a1/upgrade-mappings?dryRun=1');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.dryRun, true);
    assert.strictEqual(body.saved, false);
    assert.strictEqual(body.version, 4);
    assert.deepStrictEqual(body.evidence, { lastRun: true, sample: false });
    assert.deepStrictEqual(body.counts, { changed: 2, kept: 3 });
    assert.deepStrictEqual(body.changed.map(c => [c.field, c.take, c.label]), [
        ['inputs.to', 'one', 'Klant › E-mail adres'],
        ['inputs.first', 'one', 'Orders › ID'],
    ]);
    assert.strictEqual(body.changed[1].source, 'Orders ophalen');
    assert.deepStrictEqual(body.kept.map(k => [k.field, k.reason]), [
        ['inputs.count', 'formula'],
        ['inputs.sku', 'would_change'],
        ['inputs.body', 'formula'],
    ]);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('anna@') && !text.includes('A-100'), 'no value from a run leaves the server');
    assert.deepStrictEqual(calls.update, []);
    assert.strictEqual(body.automation, undefined);
});

test('apply: one new version, the skipped binding exactly as it was, the rest reads the same', async () => {
    const { status, body } = await call('/a1/upgrade-mappings', { version: 4 }, 'ed');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.saved, true);
    assert.strictEqual(calls.update.length, 1);
    const [{ id, updates, userId, opts }] = calls.update;
    assert.strictEqual(id, 'a1');
    assert.strictEqual(userId, 'ed', 'the person who applied it is the author');
    assert.deepStrictEqual(Object.keys(updates), ['definition']);
    assert.deepStrictEqual(opts.versionMeta.descriptionJson, [{ code: 'mappings_upgraded', params: { count: 2 } }]);
    const before = definition().steps[1].inputs;
    const after = updates.definition.steps[1].inputs;
    assert.deepStrictEqual(after.sku, before.sku, 'a binding whose value would change is skipped');
    assert.deepStrictEqual(after.body, before.body);
    assert.deepStrictEqual(after.count, before.count, 'an expr stays as it is');
    assert.strictEqual(after.to.kind, 'pick');
    assert.strictEqual(after.first.kind, 'pick');
    // On every run it was checked against, every input reads what it read.
    const states = await recentRunStates(automations.a1, fakeStore());
    assert.strictEqual(states.length, 2);
    const resolver = createResolver({ evaluate });
    for (const state of states) {
        assert.deepStrictEqual(
            JSON.parse(JSON.stringify(resolver.resolveInputs(after, state, { silent: true }))),
            JSON.parse(JSON.stringify(resolver.resolveInputs(before, state, { silent: true }))),
        );
    }
    assert.strictEqual(body.automation.myRole, 'edit');
    assert.strictEqual(body.version, 5);
});

test('the evidence: one runState per live run, each its own data; a failed row is no data, pins are a sample', async () => {
    const [newest, older, ...rest] = await recentRunStates(automations.a1, fakeStore());
    assert.deepStrictEqual(rest, [], 'a dry run is never evidence');
    assert.deepStrictEqual(newest.trigger.output, PAYLOAD, 'the newest LIVE payload, never a dry run\'s');
    assert.deepStrictEqual(newest.steps, { get: { output: ORDERS } }, 'a failed row is no data; a flowlet\'s own step is not a step of this graph');
    assert.deepStrictEqual(older.trigger.output, { Klant: {} }, 'the older run keeps its own payload');
    assert.deepStrictEqual(older.steps, { mail: { output: { sent: true } } }, 'and only its own outputs');
    assert.deepStrictEqual(await recentRunStates({ id: 'none' }, fakeStore()), []);

    // Inside a run the last attempt decides; a truncated output is no data;
    // a run with no data at all adds nothing.
    runs = [
        { id: 'q2', automationId: 'q', mode: 'live', triggerPayload: null },
        { id: 'q1', automationId: 'q', mode: 'live', triggerPayload: null },
    ];
    stepRows = [
        { runId: 'q2', stepId: 'a', status: 'success', output: { v: 1 } },
        { runId: 'q2', stepId: 'a', status: 'error', output: null },
        { runId: 'q2', stepId: 'b', status: 'error', output: null },
        { runId: 'q2', stepId: 'b', status: 'success', output: { v: 2 } },
        { runId: 'q2', stepId: 'c', status: 'success', output: { __truncated__: true, originalBytes: 300000 } },
        { runId: 'q1', stepId: 'a', status: 'error', output: null },
    ];
    const only = await recentRunStates({ id: 'q' }, fakeStore());
    assert.strictEqual(only.length, 1);
    assert.deepStrictEqual(only[0].steps, { b: { output: { v: 2 } } });

    assert.strictEqual(sampleState({ steps: [] }), null);
    const pinned = sampleState({
        trigger: { kind: 'manual', pinnedOutput: { a: 1 } },
        steps: [{ id: 'lp', type: 'loop', body: [{ id: 'in', pinnedOutput: [1] }] }],
    });
    assert.deepStrictEqual(pinned.trigger.output, { a: 1 });
    assert.deepStrictEqual(pinned.steps, { in: { output: [1] } });
    assert.deepStrictEqual(sampleState({ manualTriggerPayload: { b: 2 }, steps: [] }).trigger.output, { b: 2 }, 'the saved test input');
});

test('without a run nothing is upgraded: nothing shows the values agree', async () => {
    runs = [];
    const { body } = await call('/a1/upgrade-mappings?dryRun=true');
    assert.deepStrictEqual(body.evidence, { lastRun: false, sample: false });
    assert.deepStrictEqual(body.changed, []);
    assert.deepStrictEqual(body.kept.map(k => [k.field, k.reason]), [
        ['inputs.to', 'no_evidence'], ['inputs.first', 'no_evidence'], ['inputs.count', 'formula'], ['inputs.sku', 'no_evidence'], ['inputs.body', 'formula'],
    ]);
});

test('every recent run is checked on its own: equal on the newest run is not enough', async () => {
    automations.a1.definition.steps[1].inputs = { id: ref('trigger.output.orders.id') };
    runs = [
        { id: 'n', automationId: 'a1', mode: 'live', triggerKind: 'webhook', triggerPayload: { orders: { id: 'A-1' } }, startedAt: '2026-10-01T09:00:00Z' },
        { id: 'o', automationId: 'a1', mode: 'live', triggerKind: 'webhook', triggerPayload: { orders: [{ id: 'B-1' }, { id: 'B-2' }] }, startedAt: '2026-09-30T09:00:00Z' },
    ];
    stepRows = [];
    const refused = await call('/a1/upgrade-mappings?dryRun=1');
    assert.deepStrictEqual(refused.body.changed, []);
    assert.deepStrictEqual(refused.body.kept.map(k => [k.field, k.reason]), [['inputs.id', 'would_change']]);
    assert.ok(!JSON.stringify(refused.body).includes('B-1'), 'no run value in the answer');

    runs[1].triggerPayload = { orders: { id: 'C-1' } };
    const accepted = await call('/a1/upgrade-mappings?dryRun=1');
    assert.deepStrictEqual(accepted.body.changed.map(c => c.field), ['inputs.id']);
    assert.deepStrictEqual(accepted.body.evidence, { lastRun: true, sample: false });
    assert.strictEqual(accepted.body.states, undefined, 'the runStates never reach a client');
});

test('a pinned sample is evidence too', async () => {
    runs = [];
    automations.a1.definition.trigger.pinnedOutput = PAYLOAD;
    const { body } = await call('/a1/upgrade-mappings?dryRun=1');
    assert.deepStrictEqual(body.evidence, { lastRun: false, sample: true });
    assert.deepStrictEqual(body.changed.map(c => c.field), ['inputs.to']);
});

test('the gate is PUT /:id\'s: edit or owner', async () => {
    assert.strictEqual((await call('/a1/upgrade-mappings?dryRun=1', undefined, 'vic')).status, 403);
    assert.strictEqual((await call('/a1/upgrade-mappings', undefined, 'ron')).status, 403);
    assert.strictEqual((await call('/zz/upgrade-mappings?dryRun=1')).status, 404);
    assert.deepStrictEqual(calls.update, []);
    assert.deepStrictEqual(calls.runs, [], 'a refused caller reads no run');
});

test('a stale preview, nothing to change, no steps, a bad request', async () => {
    const stale = await call('/a1/upgrade-mappings', { version: 3 });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'version_changed');

    const nothing = await call('/lit/upgrade-mappings', {});
    assert.strictEqual(nothing.status, 200);
    assert.strictEqual(nothing.body.saved, false);
    assert.deepStrictEqual(nothing.body.counts, { changed: 0, kept: 0 });

    const bare = await call('/bare/upgrade-mappings?dryRun=1');
    assert.strictEqual(bare.status, 400);
    assert.strictEqual(bare.body.code, 'no_definition');

    assert.strictEqual((await call('/a1/upgrade-mappings?dryRun=yes')).status, 400);
    assert.strictEqual((await call('/a1/upgrade-mappings', { version: 'x' })).status, 400);
    assert.strictEqual((await call('/a1/upgrade-mappings', { definition: {} })).status, 400);
    assert.deepStrictEqual(calls.update, []);
});

test('an upgraded definition that does not validate is refused, nothing written', async () => {
    const strict = serve('/', makeUpgradeMappingsRouter({
        store: fakeStore(), access,
        validateDefinition: () => ({ ok: false, errors: [{ code: 'x', message: 'bad' }] }),
    }));
    try {
        const { status, body } = await strict.call('POST', '/a1/upgrade-mappings', { body: {}, user: { id: 'owner' } });
        assert.strictEqual(status, 400);
        assert.strictEqual(body.code, 'invalid_definition');
        assert.deepStrictEqual(calls.update, []);
    } finally {
        strict.close();
    }
});
