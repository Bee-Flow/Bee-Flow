/**
 * routes/automation/upgradeMappings.js, M8b: the AI fix
 * (POST /:id/upgrade-mappings/ai-fix), applying its suggestions, and the
 * update on open (`auto: true`). A real Express app with the store, the
 * access guard, the org setting and the model injected (no module mocking);
 * the upgrade, the resolver and the gate are the real ones.
 *
 * Proven:
 *   - auth: the AI fix needs edit, like the upgrade; a refused caller costs
 *     no model call and reads no run; an unknown routine is a 404;
 *   - the AI fix answers only suggestions that passed the dry run, writes
 *     nothing, logs one usage row with the model it used, and carries no
 *     value from a run; with nothing to ask no model is resolved or called;
 *     no model is a 503, a failing model a 502;
 *   - applying suggestions: dry-run again, saved in the same new version as
 *     the upgrade, counted apart; one that no longer agrees refuses all;
 *   - auto: with the organisation's setting off nothing is read or written;
 *     on, the provably-equal upgrade is saved, with the version before it
 *     for Undo (only when that version row holds exactly the definition the
 *     save replaced); never with AI suggestions;
 *   - the AI fix never asks about, nor applies, a list function.
 *
 * Run: cd server && node --test routes/automation/upgradeMappings.m8b.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeUpgradeMappingsRouter } = require('./upgradeMappings');
const { serve } = require('../../core/http/routeHarness');
const { accessByRole } = require('./testing/accessByRole');

const ref = (path) => ({ kind: 'ref', path });
const expr = (value) => ({ kind: 'expr', value });
const ORDERS_PICK = { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders'] }, take: 'one', as: 'native' };

function definition() {
    return {
        trigger: { id: 't', type: 'trigger', kind: 'webhook' },
        steps: [
            { id: 'get', type: 'integration_action', tool: 'shop_orders', label: 'Orders ophalen', inputs: {} },
            {
                id: 'mail', type: 'integration_action', tool: 'gmail_send', label: 'Mail klant',
                inputs: {
                    to: ref('trigger.output.email'),
                    orders: expr('steps.get.output.orders'),
                    // A list function: never asked about (it differs from its pick on []).
                    first: expr('first(steps.get.output.orders[*].id)'),
                    shout: expr('upper(steps.get.output.orders[0].id)'),
                },
            },
        ],
        edges: [{ from: 't', to: 'get' }, { from: 'get', to: 'mail' }],
    };
}

const PAYLOAD = { email: 'SENTINEL@voorbeeld.nl' };
const ORDERS = { orders: [{ id: 'SENTINEL-1' }, { id: 'SENTINEL-2' }] };

let automations;
let runs;
let calls;
let orgSetting;
let modelAnswer;
let model;
let versionRows;

function fakeStore() {
    return {
        async getAutomation(id) { return automations[id] ? structuredClone(automations[id]) : null; },
        async updateAutomation(id, updates, userId, opts) {
            calls.update.push({ id, updates, userId, opts });
            automations[id] = { ...automations[id], ...updates, version: automations[id].version + 1 };
            return structuredClone(automations[id]);
        },
        async getRunsForAutomation(id) { calls.runs.push(id); return runs.filter(r => r.automationId === id); },
        async getRunSteps(runId) { return runId === 'r1' ? [{ runId, stepId: 'get', status: 'success', output: ORDERS }] : []; },
        async getVersionByNumber(id, n) { return { id: `row-${id}-${n}`, version: n, definition: structuredClone(versionRows[`${id}:${n}`]) }; },
    };
}

const access = accessByRole({ owner: 'owner', ed: 'edit', vic: 'view', ron: 'run' });
let api;

beforeEach(() => {
    calls = { update: [], runs: [], chat: [], usage: [], models: 0, settings: [] };
    orgSetting = false;
    model = 'fast-model';
    automations = {
        a1: { id: 'a1', userId: 'owner', organizationId: 'org1', title: 'Orders', definition: definition(), version: 4 },
        lit: { id: 'lit', userId: 'owner', organizationId: 'org1', title: 'Literals', definition: { trigger: { kind: 'manual' }, steps: [{ id: 's', type: 'integration_action', inputs: { a: { kind: 'literal', value: 1 } } }] }, version: 1 },
    };
    versionRows = { 'a1:4': definition() };
    runs = [{ id: 'r1', automationId: 'a1', mode: 'live', triggerKind: 'webhook', triggerPayload: PAYLOAD, startedAt: '2026-10-01T09:00:00Z' }];
    // The model proposes the right pick for the orders, and for the upper-cased
    // id one that reads every id instead.
    modelAnswer = (fields) => fields.map(f => (f.text === 'steps.get.output.orders'
        ? { id: f.id, binding: ORDERS_PICK }
        : { id: f.id, binding: { kind: 'pick', from: { root: 'steps', id: 'get', path: ['orders', 'id'] }, take: 'all', as: 'native' } }));
});

before(() => {
    api = serve('/', makeUpgradeMappingsRouter({
        store: fakeStore(),
        access,
        mappingSettings: { async readMappingSettings(orgId) { calls.settings.push(orgId); return { autoUpgradeOnOpen: orgSetting }; } },
        orgIdOf: async (req) => req.session.user.organizationId || null,
        resolveModel: async () => { calls.models++; return model; },
        chat: async (modelId, messages, tool, opts) => {
            calls.chat.push({ modelId, messages, tool, opts });
            if (model === 'broken') throw new Error('provider down');
            const fields = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('\n') + 1)).fields;
            return { structured: { proposals: modelAnswer(fields) }, usage: { input_tokens: 100, output_tokens: 20 } };
        },
        logUsage: async (row) => { calls.usage.push(row); },
        rateLimit: { windowMs: 60_000, max: 1000 },
    }));
});
after(() => api.close());

const call = (path, body, user = 'owner') => api.call('POST', path, { body, user: { id: user, organizationId: 'org1' } });

test('the AI fix: only what passed the dry run, nothing written, one usage row, no run value', async () => {
    const { status, body } = await call('/a1/upgrade-mappings/ai-fix', { version: 4 }, 'ed');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.version, 4);
    assert.deepStrictEqual(body.suggestions.map(s => [s.field, s.take]), [['inputs.orders', 'one']]);
    assert.deepStrictEqual(body.suggestions[0].binding, ORDERS_PICK);
    assert.deepStrictEqual(body.counts, { candidates: 2, noEvidence: 0, asked: 2, accepted: 1, discarded: 1, truncated: false });
    assert.deepStrictEqual(calls.update, [], 'a suggestion is never saved by itself');
    assert.strictEqual(calls.chat.length, 1);
    assert.strictEqual(calls.chat[0].modelId, 'fast-model');
    assert.ok(!JSON.stringify(calls.chat[0].messages).includes('SENTINEL'), 'the model sees no run value');
    assert.ok(!JSON.stringify(body).includes('SENTINEL'), 'nor does the answer carry one');
    assert.deepStrictEqual(calls.usage.map(u => [u.userId, u.userOrgId, u.automationId, u.modelId]), [['ed', 'org1', 'a1', 'fast-model']]);
    assert.deepStrictEqual(calls.usage[0].usage, { input_tokens: 100, output_tokens: 20 });
});

test('the AI fix needs edit; a refused caller costs no model call and reads no run', async () => {
    assert.strictEqual((await call('/a1/upgrade-mappings/ai-fix', {}, 'vic')).status, 403);
    assert.strictEqual((await call('/a1/upgrade-mappings/ai-fix', {}, 'ron')).status, 403);
    assert.strictEqual((await call('/zz/upgrade-mappings/ai-fix', {})).status, 404);
    assert.deepStrictEqual([calls.chat, calls.runs, calls.usage, calls.models], [[], [], [], 0]);
    const stale = await call('/a1/upgrade-mappings/ai-fix', { version: 3 });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'version_changed');
    assert.strictEqual((await call('/a1/upgrade-mappings/ai-fix', { aiFixes: [] })).status, 400, 'a closed body');
});

test('nothing to ask: no model resolved, none called, no usage', async () => {
    runs = [];
    const { status, body } = await call('/a1/upgrade-mappings/ai-fix', {});
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.suggestions, []);
    assert.strictEqual(body.counts.noEvidence, 2, 'without data the fields are not sent');
    assert.deepStrictEqual([calls.chat, calls.usage, calls.models], [[], [], 0]);
    assert.strictEqual((await call('/lit/upgrade-mappings/ai-fix', {})).body.counts.candidates, 0);
});

test('no model is a 503; a failing model a 502, its tokens still counted', async () => {
    model = null;
    const none = await call('/a1/upgrade-mappings/ai-fix', {});
    assert.strictEqual(none.status, 503);
    assert.strictEqual(none.body.code, 'no_model');
    assert.deepStrictEqual(calls.usage, []);
    model = 'broken';
    const down = await call('/a1/upgrade-mappings/ai-fix', {});
    assert.strictEqual(down.status, 502);
    assert.strictEqual(down.body.code, 'ai_unavailable');
    assert.strictEqual(calls.usage.length, 1);
    assert.deepStrictEqual(calls.update, []);
});

test('applying suggestions: checked again, saved with the upgrade in one version, counted apart', async () => {
    const { status, body } = await call('/a1/upgrade-mappings', {
        version: 4, aiFixes: [{ stepId: 'mail', field: 'inputs.orders', binding: ORDERS_PICK }],
    }, 'ed');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.saved, true);
    assert.strictEqual(calls.update.length, 1);
    const [{ updates, opts }] = calls.update;
    assert.deepStrictEqual(updates.definition.steps[1].inputs.orders, ORDERS_PICK);
    assert.strictEqual(updates.definition.steps[1].inputs.to.kind, 'pick', 'the deterministic upgrade rides along');
    assert.deepStrictEqual(updates.definition.steps[1].inputs.first, expr('first(steps.get.output.orders[*].id)'));
    assert.deepStrictEqual(opts.versionMeta.descriptionJson, [{ code: 'mappings_upgraded', params: { count: 2, ai: 1 } }]);
    assert.deepStrictEqual(body.changed.map(c => [c.field, c.ai === true]), [['inputs.to', false], ['inputs.orders', true]]);
    assert.deepStrictEqual(body.kept.map(k => k.field), ['inputs.first', 'inputs.shout']);
    assert.deepStrictEqual(body.previous, { version: 4, versionId: 'row-a1-4' });
});

test('a suggestion that no longer gives the same result refuses all; nothing written', async () => {
    const wrong = { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders', 'id'] }, take: 'all', as: 'native' };
    const res = await call('/a1/upgrade-mappings', {
        aiFixes: [{ stepId: 'mail', field: 'inputs.orders', binding: ORDERS_PICK }, { stepId: 'mail', field: 'inputs.shout', binding: wrong }],
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'ai_fix_changed');
    const upgraded = await call('/a1/upgrade-mappings', { aiFixes: [{ stepId: 'mail', field: 'inputs.to', binding: ORDERS_PICK }] });
    assert.strictEqual(upgraded.status, 409, 'a field the upgrade itself takes is not the AI fix\'s');
    const listFn = await call('/a1/upgrade-mappings', { aiFixes: [{ stepId: 'mail', field: 'inputs.first', binding: { ...ORDERS_PICK, from: { root: 'steps', id: 'get', path: ['orders', 'id'] }, take: 'first' } }] });
    assert.strictEqual(listFn.status, 409, 'nor is a list function');
    assert.deepStrictEqual(calls.update, []);
});

test('auto: off reads and writes nothing; on saves the provable upgrade with Undo; never AI suggestions', async () => {
    const off = await call('/a1/upgrade-mappings', { version: 4, auto: true }, 'ed');
    assert.strictEqual(off.status, 200);
    assert.deepStrictEqual(off.body, { dryRun: false, version: 4, saved: false, autoOff: true });
    assert.deepStrictEqual(calls.settings, ['org1']);
    assert.deepStrictEqual([calls.runs, calls.update], [[], []]);

    orgSetting = true;
    const on = await call('/a1/upgrade-mappings', { version: 4, auto: true }, 'ed');
    assert.strictEqual(on.body.saved, true);
    assert.deepStrictEqual(on.body.changed.map(c => c.field), ['inputs.to']);
    assert.deepStrictEqual(on.body.previous, { version: 4, versionId: 'row-a1-4' });
    assert.deepStrictEqual(calls.update[0].opts.versionMeta.descriptionJson, [{ code: 'mappings_upgraded', params: { count: 1, auto: true } }]);
    assert.deepStrictEqual(calls.chat, [], 'no model is asked on open');

    const withAi = await call('/a1/upgrade-mappings', { auto: true, aiFixes: [{ stepId: 'mail', field: 'inputs.orders', binding: ORDERS_PICK }] });
    assert.strictEqual(withAi.status, 400);
    assert.strictEqual((await call('/a1/upgrade-mappings', { auto: 'true' })).status, 400);
    assert.strictEqual((await call('/a1/upgrade-mappings', { auto: true }, 'vic')).status, 403);
    assert.strictEqual(calls.update.length, 1);
});

test('Undo only restores a version row that holds exactly the definition the save replaced', async () => {
    // A layout-only write after version 4 got no row of its own: restoring
    // row 4 would undo that write too, so no row is offered.
    versionRows['a1:4'] = { ...definition(), layout: { t: { x: 0, y: 0 } } };
    orgSetting = true;
    const { body } = await call('/a1/upgrade-mappings', { version: 4, auto: true }, 'ed');
    assert.strictEqual(body.saved, true);
    assert.deepStrictEqual(body.previous, { version: 4, versionId: null });
});
