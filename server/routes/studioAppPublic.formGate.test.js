/**
 * The form values a step of a PUBLIC app page receives (routes/studioAppPublic.js): a visitor
 * carries the reserved role `public`, so the value of a field gated to another role is left
 * out before the step runs; an ungated field and one that names `public` pass. A form without
 * a gated field hands on exactly what was sent.
 *
 * Run: cd server && node --test routes/studioAppPublic.formGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../testUtils/routeHarness');
const { issueVisitorToken } = require('../auth/publicShareToken');

const field = (name, gate) => ({ id: `in_${name}`, type: 'input_text', props: { name }, ...(gate ? { visibleToRoles: gate } : {}) });
const formOf = (id, onSubmit, children) => ({ id, type: 'form', props: { name: id }, onSubmit, children });
const WRITE = { kind: 'create_record', tableId: 'tbl_x', values: {} };
const definition = {
    schemaVersion: 2,
    publicAccess: { entryScreenId: 'scr_1', screenIds: ['scr_1'] },
    screens: [{ id: 'scr_1', name: 'Request', sections: [{ id: 'sec_1', children: [
        formOf('frm_open', 'act_open', [field('title'), field('note')]),
        formOf('frm_gated', 'act_gated', [field('title'), field('note', ['public', 'admin']), field('approvedBy', ['admin'])]),
    ] }] }],
    actions: { act_open: { kind: 'sequence', steps: [WRITE] }, act_gated: { kind: 'sequence', steps: [WRITE] } },
};

const stepCalls = [];
const { api } = h.routeUnderTest(test, '/api/public-app', () => {
    const studioAppStore = require('../stores/studioAppStore');
    const studioAppDataStore = require('../stores/studioAppDataStore');
    const actionExecutor = require('../appStudio/actionExecutor');
    test.mock.method(studioAppStore, 'getPublicPage', async () => ({ appId: 'app1' }));
    test.mock.method(studioAppStore, 'getStudioApp', async () => ({ id: 'app1', userId: 'owner', isPublished: true, publishedDefinition: definition }));
    test.mock.method(studioAppDataStore, 'getDataModel', async () => ({ model: { modelVersion: 1, tables: [] } }));
    test.mock.method(actionExecutor, 'executeDataStep', async (_app, _model, step, ctx) => {
        stepCalls.push({ step, ctx });
        return { ok: true, result: { id: 'rec_1' } };
    });
    return require('./studioAppPublic');
}, { gates: false, user: null });

const PAGE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
const visitor = { authorization: `Bearer ${issueVisitorToken({ pageToken: PAGE, appId: 'app1', viewerId: 'anon:1' })}` };
const SENT = { title: 'Laptop', note: 'soon', approvedBy: 'someone' };
const step = (actionId) => api.call('POST', `/api/public-app/${PAGE}/actions/${actionId}/step`, { body: { stepIndex: 0, formValues: SENT, vars: {} }, headers: visitor });

test.beforeEach(() => { stepCalls.length = 0; });

test('a form without a gated field hands the step exactly what the visitor sent', async () => {
    const res = await step('act_open');
    assert.equal(res.status, 200, res.text);
    assert.equal(stepCalls.length, 1);
    assert.equal(stepCalls[0].ctx.role, 'public');
    assert.deepEqual(stepCalls[0].ctx.formValues, SENT);
});

test('a field gated to another role is left out for the visitor; one that names public passes', async () => {
    const res = await step('act_gated');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(stepCalls[0].ctx.formValues, { title: 'Laptop', note: 'soon' });
});
