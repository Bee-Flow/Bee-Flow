/**
 * routes/automation/usage.js — GET /_usage/steps and GET /_usage/values over a
 * real Express app, with the definitions loader and the scope injected
 * through makeUsageRouter (no module mocking).
 *
 * Proven:
 *   - /_usage/steps answers the caller's org counts as a bare [{ key, count }];
 *   - /_usage/values answers the top five literals for (tool, input) as a bare
 *     [{ value, count }], reads 'inputs.path' as 'path', and never returns a
 *     value that looks like personal data;
 *   - someone else's value is only offered once two people use it; the
 *     caller always sees their own;
 *   - the scope is the caller's organisation, so another org's routines never
 *     show up;
 *   - a missing or malformed tool/input is a 400 invalid_request.
 *
 * Run: cd server && node --test routes/automation/usage.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeUsageRouter } = require('./usage');
const { makeOrgStepUsage } = require('../../automation/orgStepUsage');
const { serve } = require('../../core/http/routeHarness');

const list = (path) => ({ id: 'x', type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path } });

const own = (ownerId, definition) => ({ ownerId, definition });
const BY_ORG = {
    org1: [
        own('u1', { steps: [list('/Invoices'), list('/Invoices'), list('/Photos'), { id: 'a', type: 'ai_step' }] }),
        own('u3', { steps: [list({ kind: 'literal', value: '/Invoices' }), list('piet@example.nl'), list('+31 6 12345678'), list('/Documents')] }),
        own('u3', { steps: ['/a', '/b', '/c', '/d'].map(list) }),
        own('u4', { steps: ['/a', '/b', '/HR/Jan de Vries'].map(list) }),
    ],
    org2: [own('u9', { steps: [list('/SecretOrg2Folder'), { id: 'c', type: 'code' }] })],
};

let api;
let currentUser = { id: 'u1', orgId: 'org1' };
const loads = [];

before(() => {
    api = serve('/', makeUsageRouter({
        usage: makeOrgStepUsage({
            loadDefinitions: async (scope) => { loads.push(scope); return BY_ORG[scope.orgId] || []; },
        }),
        resolveScope: async (req) => ({ orgId: currentUser.orgId, userId: req.session.user.id }),
    }));
});

after(() => api.close());

const get = (path) => api.call('GET', path, { user: { id: currentUser.id } });

test('GET /_usage/steps: the org\'s step kinds and actions, most used first', async () => {
    currentUser = { id: 'u1', orgId: 'org1' };
    const { status, body } = await get('/_usage/steps');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    assert.deepStrictEqual(body, [
        { key: 'action:nextcloud_list_files', count: 14 },
        { key: 'step:ai_step', count: 1 },
    ]);
});

test('GET /_usage/values: top five literals, no personal data', async () => {
    currentUser = { id: 'u2', orgId: 'org1' };
    const { status, body } = await get('/_usage/values?tool=nextcloud_list_files&input=path');
    assert.strictEqual(status, 200);
    // u2 typed none of these: only values two people use are offered. u1's
    // /Photos, u3's /Documents, /c and /d and u4's /HR/Jan de Vries stay with them.
    assert.deepStrictEqual(body, [
        { value: '/Invoices', count: 3 },
        { value: '/a', count: 2 },
        { value: '/b', count: 2 },
    ]);
    const all = JSON.stringify(body);
    assert.doesNotMatch(all, /@|12345678|Jan de Vries|Photos|Documents/);
    const prefixed = await get('/_usage/values?tool=nextcloud_list_files&input=inputs.path');
    assert.deepStrictEqual(prefixed.body, body);
    // Both org1 callers shared one load.
    assert.strictEqual(loads.filter(s => s.orgId === 'org1').length, 1);
});

test('the caller always sees their own values, even ones nobody else uses', async () => {
    currentUser = { id: 'u4', orgId: 'org1' };
    const { body } = await get('/_usage/values?tool=nextcloud_list_files&input=path');
    assert.ok(body.some(r => r.value === '/HR/Jan de Vries'), 'u4 typed it');
    assert.ok(!body.some(r => r.value === '/Photos'), 'u1 alone typed that');
});

test('another organisation never sees org1\'s values, and vice versa', async () => {
    currentUser = { id: 'u9', orgId: 'org2' };
    const values = await get('/_usage/values?tool=nextcloud_list_files&input=path');
    assert.deepStrictEqual(values.body, [{ value: '/SecretOrg2Folder', count: 1 }]);
    const steps = await get('/_usage/steps');
    assert.deepStrictEqual(steps.body.map(r => r.key).sort(), ['action:nextcloud_list_files', 'step:code']);
    currentUser = { id: 'u1', orgId: 'org1' };
    const back = await get('/_usage/values?tool=nextcloud_list_files&input=path');
    assert.doesNotMatch(JSON.stringify(back.body), /SecretOrg2Folder/);
});

test('unknown tool or input: an empty list', async () => {
    const { status, body } = await get('/_usage/values?tool=gmail_send&input=to');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, []);
});

test('missing or malformed query: 400 invalid_request', async () => {
    for (const q of ['', '?tool=nextcloud_list_files', '?input=path', '?tool=bad%20tool&input=path', '?tool=x&input=' + 'a'.repeat(200)]) {
        const { status, body } = await get(`/_usage/values${q}`);
        assert.strictEqual(status, 400, q);
        assert.strictEqual(body.code, 'invalid_request', q);
    }
});
