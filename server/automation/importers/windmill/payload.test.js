/**
 * A Windmill run's `flow_input` as the trigger payload of the converted draft
 * (payload.mts remapRunInput, PLAN B6): the same table the expressions are
 * re-mapped with, read the other way, so a dry run of the draft sees the
 * fields its steps read.
 *
 * Run: cd server && node --test automation/importers/windmill/payload.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { remapRunInput } = require('./payload.mts');
const { toBeeFlow, toIntermediate } = require('./index.mts');
const { inputOf } = require('./goldenFixtures.mjs');

test('a Nextcloud file event becomes the flat Bee Flow fields; the connection is left out', () => {
    const input = {
        time: 1731600000,
        user: { uid: 'alice', displayName: 'Alice A.' },
        authentication: { owner: 'alice', trigger: { userId: 'alice' }, app_password: 'not-carried' },
        event: { class: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', node: { id: 42, path: '/alice/files/Invoices/a.pdf', name: 'a.pdf' }, unknown: 1 },
    };
    assert.deepStrictEqual(remapRunInput('nextcloud', 'file.new', input), {
        path: '/Invoices/a.pdf', id: 42, name: 'a.pdf', actor: 'alice', actorName: 'Alice A.',
    });
});

test('the trigger user id stands in for the actor when the user is missing; a path outside a user\'s files is left out', () => {
    const input = { authentication: { trigger: { userId: 'bob' } }, event: { node: { path: '/appdata_x/preview/1' } } };
    assert.deepStrictEqual(remapRunInput('nextcloud', 'file.changed', input), { actor: 'bob' });
});

test('forms and tables events read their own fields', () => {
    assert.deepStrictEqual(remapRunInput('nextcloud', 'forms.submitted', { event: { form: { id: 7, title: 'Leave' }, submission: { id: 9, userId: 'carol' } } }), {
        formId: 7, formTitle: 'Leave', submissionId: 9, submittedBy: 'carol',
    });
    assert.deepStrictEqual(remapRunInput('nextcloud', 'tables.row_added', { event: { tableId: 3, rowId: 11, values: [{ columnId: 1, value: 'x' }] } }), {
        tableId: 3, rowId: 11, values: [{ columnId: 1, value: 'x' }],
    });
});

test('a webhook, form or manual flow: the input itself, without authentication; a schedule: none', () => {
    const input = { net: 10, rate: 21, authentication: { token: 'x' } };
    for (const kind of ['webhook', 'form', 'manual']) assert.deepStrictEqual(remapRunInput(kind, null, input), { net: 10, rate: 21 }, kind);
    assert.strictEqual(remapRunInput('schedule', null, input), null);
    assert.deepStrictEqual(remapRunInput('form', null, 'not an object'), {});
});

test('a crafted __proto__ key in a run input is never followed or copied', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "net": 1, "event": {"__proto__": {"x": 1}}}');
    const out = remapRunInput('form', null, input);
    assert.deepStrictEqual(Object.keys(out), ['net', 'event']);
    assert.strictEqual(({}).polluted, undefined);
    assert.deepStrictEqual(remapRunInput('nextcloud', 'file.new', input), {});
});

test('the converter says what flow_input is per flow, and which steps keep Windmill\'s result shape', async () => {
    const shim = toBeeFlow(await toIntermediate(await inputOf('ts-pure-shim.flow')));
    assert.deepStrictEqual(shim.flows[0].payload, { kind: 'form', event: null });
    assert.deepStrictEqual(shim.flows[0].outputs.map((o) => [o.wmId, o.stepId, o.path]), [['vat', 'vat', ['result']], ['label', 'label', ['result']]]);
    const bundle = toBeeFlow(await toIntermediate(await inputOf('native-trigger-bundle')));
    const byPath = new Map(bundle.flows.map((f) => [f.flowPath, f.payload]));
    assert.strictEqual(byPath.get('f/ops/invoice_intake').kind, 'nextcloud');
    assert.ok(byPath.get('f/ops/invoice_intake').event.startsWith('file.'));
    assert.deepStrictEqual(byPath.get('f/ops/ticket_hook'), { kind: 'webhook', event: null });
});
