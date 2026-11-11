/**
 * The http_request step through the canonicalizer and the validator: what a definition may say
 * (validate/httpRequestChecks.mts), and that a definition without the step is untouched.
 *
 * Run: node --test server/appStudio/validate/httpRequestChecks.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { STEP_POLICY_LISTS, stepPolicy } = require('../componentSpecs/stepRegistry');
const { isRetryUnsafeKind } = require('../../shared/appDefinition/stepFlow.mjs');
const { connectorIdsOfKind } = require('./httpRequestChecks.mts');

const MODEL = { tables: [], connectors: [{ id: 'conn_ab12cd', kind: 'rest', url: 'https://api.example.test/v1' }, { id: 'conn_mail01', kind: 'mailbox', provider: 'gmail' }] };

function defWith(step) {
    return {
        schemaVersion: 2, meta: { name: 'Orders', description: '', icon: 'LayoutGrid' }, homeScreenId: 'scr_a00001', roles: [],
        screens: [{ id: 'scr_a00001', name: 'A', sections: [{ id: 'sec_a00001', children: [{ id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_http01' }] }] }],
        actions: { act_http01: { kind: 'sequence', steps: [step] } },
    };
}

/** The error and warning codes of the step, after canonicalizing. */
function check(step, opts = { dataModel: MODEL }) {
    const { def } = canonicalizeAppDefinition(defWith(step));
    const res = validateAppDefinition(def, opts);
    const mine = (list) => list.filter((f) => f.path.startsWith('actions.act_http01')).map((f) => `${f.code} @ ${f.path.replace('actions.act_http01.steps[0]', 'step')}`);
    return { def, step: def.actions.act_http01.steps[0], errors: mine(res.errors), warnings: mine(res.warnings) };
}

const GOOD = {
    kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/v1/orders/{{form.orderId}}/notes',
    query: { region: { kind: 'formula', expr: 'vars.region' } }, headers: { 'X-Trace': { kind: 'static', value: 'on' } },
    body: { kind: 'static', value: { text: '{{form.note}}' } }, bodyFormat: 'json', expect: 'json',
    idempotencyKey: { kind: 'formula', expr: 'form.orderId' }, resultVar: 'note', retry: { times: 2 },
};

test('a complete step is kept as written, validates, and marks the definition schema version 3', () => {
    const { def, step, errors, warnings } = check(GOOD);
    assert.deepEqual(step, GOOD);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(def.schemaVersion, 3);
});

test('a minimal step gets the three enum defaults and nothing else', () => {
    const { step, errors } = check({ kind: 'http_request', connectorId: 'conn_ab12cd' });
    assert.deepEqual(step, { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'GET', bodyFormat: 'json', expect: 'json' });
    assert.deepEqual(errors, []);
});

test('a definition without the step keeps its schema version and its bytes', () => {
    const plain = defWith({ kind: 'toast', message: 'Hi', tone: 'info' });
    const first = canonicalizeAppDefinition(JSON.parse(JSON.stringify(plain))).def;
    assert.equal(first.schemaVersion, 2);
    assert.equal(JSON.stringify(first).includes('http_request'), false);
});

test('there is no field for a URL: unknown fields are dropped by the canonicalizer and refused by the validator', () => {
    const { step } = check({ ...GOOD, url: 'https://evil.example/', host: 'evil.example', auth: { connectionId: 'x' } });
    assert.deepEqual(step, GOOD);
    const res = validateAppDefinition(defWith({ ...GOOD, url: 'https://evil.example/' }), { dataModel: MODEL });
    assert.ok(res.errors.some((e) => e.code === 'action.step_unknown_field' && e.path.endsWith('.url')));
});

test('the connector must be a rest connector of the app: an error at publish, a warning on a draft save, unchecked without a model', () => {
    for (const connectorId of ['conn_mail01', 'conn_nope00']) {
        assert.deepEqual(check({ ...GOOD, connectorId }).errors, ['action.http_connector_invalid @ step.connectorId']);
        const draft = check({ ...GOOD, connectorId }, { dataModel: MODEL, dataRefsAsWarnings: true });
        assert.deepEqual(draft.errors, []);
        assert.deepEqual(draft.warnings, ['action.http_connector_invalid @ step.connectorId']);
        assert.deepEqual(check({ ...GOOD, connectorId }, {}).errors, []);
    }
    assert.deepEqual(check({ ...GOOD, connectorId: undefined }).errors, ['action.step_field_required @ step.connectorId']);
});

test('the path stays a path on the connector host', () => {
    const bad = ['https://evil.example/x', '//evil.example/x', 'v1/orders', '/a/../b', '/a/%2E%2e/b', '/x?y=1', '/x#f', '/a b', '/\\evil.example', '{{vars.path}}'];
    for (const path of bad) assert.deepEqual(check({ ...GOOD, path }).errors, ['action.http_path_invalid @ step.path'], path);
    for (const path of ['/', '/v1/{{form.a}}/{{form.b}}', '/{{item.id}}', '/v1/a%20b', '/v1/{{vars.rows[0].id}}']) assert.deepEqual(check({ ...GOOD, path }).errors, [], path);
});

test('a placeholder is a path read from form, vars, item or params', () => {
    for (const path of ['/v1/{{currentUser.email}}', '/v1/{{form.a + 1}}', '/v1/{{secret}}', '/v1/{{ UPPER(form.a) }}']) {
        assert.deepEqual(check({ ...GOOD, path }).errors, ['action.http_placeholder_invalid @ step.path'], path);
    }
    assert.deepEqual(check({ ...GOOD, body: { kind: 'static', value: { a: ['{{viewer.id}}'] } } }).errors, ['action.http_placeholder_invalid @ step.body']);
});

test('headers a step may not set are refused by name', () => {
    for (const name of ['Authorization', 'cookie', 'Proxy-Authorization', 'Host', 'Idempotency-Key', 'Bad Name']) {
        assert.deepEqual(check({ ...GOOD, headers: { [name]: { kind: 'static', value: 'v' } } }).errors, [`action.http_header_refused @ step.headers.${name}`], name);
    }
});

test('query and headers hold at most LIMITS.MAX_HTTP_STEP_ENTRIES entries', () => {
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, { kind: 'static', value: i }]));
    assert.deepEqual(check({ ...GOOD, query: many }).errors, ['action.http_too_many_entries @ step.query']);
    assert.deepEqual(check({ ...GOOD, headers: many }).errors, ['action.http_too_many_entries @ step.headers']);
});

test('retry on a write needs an idempotencyKey; a GET may always be retried', () => {
    const { idempotencyKey: _key, ...noKey } = GOOD;
    assert.deepEqual(check(noKey).errors, ['action.http_retry_unsafe @ step.retry']);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.deepEqual(check({ ...noKey, method }).errors, ['action.http_retry_unsafe @ step.retry'], method);
    const { retry: _retry, ...noRetry } = noKey;
    assert.deepEqual(check(noRetry).errors, []);
    const { body: _body, ...get } = { ...noKey, method: 'GET' };
    assert.deepEqual(check(get).errors, []);
});

test('the body: ignored on a GET (a warning), JSON text must parse', () => {
    const { retry: _r, idempotencyKey: _k, ...base } = GOOD;
    assert.deepEqual(check({ ...base, method: 'GET' }).warnings, ['action.http_body_ignored @ step.body']);
    assert.deepEqual(check({ ...base, body: { kind: 'static', value: '{"a": "{{form.a}}"}' } }).errors, []);
    assert.deepEqual(check({ ...base, body: { kind: 'static', value: '{not json' } }).errors, ['action.http_body_invalid @ step.body']);
    assert.deepEqual(check({ ...base, bodyFormat: 'text', body: { kind: 'static', value: '{not json' } }).errors, []);
});

test('a formula in a query, header or body binding is checked like any server step formula', () => {
    const res = check({ ...GOOD, query: { q: { kind: 'formula', expr: 'vars.region +' } } });
    assert.ok(res.errors.length > 0);
    assert.ok(res.errors.every((e) => e.includes('step.query.q')), JSON.stringify(res.errors));
});

test('the policy of the kind: a click and a background run, never a public page or a mailbox hook', () => {
    assert.equal(stepPolicy('http_request', 'click'), 'step');
    assert.equal(stepPolicy('http_request', 'background'), 'run');
    assert.equal(stepPolicy('http_request', 'mailboxHook'), 'refuse');
    assert.equal(stepPolicy('http_request', 'unattended'), 'refuse');
    assert.equal(stepPolicy('http_request', 'public'), 'refuse');
    assert.equal(stepPolicy('http_request', 'mcpRun'), 'run');
    assert.equal(stepPolicy('http_request', 'mcpDryRun'), 'run');
    assert.ok(STEP_POLICY_LISTS.publicDeniedKinds.includes('http_request'));
    assert.ok(!STEP_POLICY_LISTS.hookStepKinds.includes('http_request'));
    assert.ok(!STEP_POLICY_LISTS.backgroundRefusedKinds.includes('http_request'));
    assert.ok(STEP_POLICY_LISTS.heavyStepKinds.includes('http_request'));
    assert.ok(!STEP_POLICY_LISTS.mcpMockableKinds.includes('http_request'));
    // The kind takes `retry` (a GET is repeatable); the per-step rule above guards a write.
    assert.equal(isRetryUnsafeKind('http_request'), false);
});

test('connectorIdsOfKind: null without a model, the ids of one kind with one', () => {
    assert.equal(connectorIdsOfKind(undefined, 'rest'), null);
    assert.deepEqual([...connectorIdsOfKind(MODEL, 'rest')], ['conn_ab12cd']);
    assert.deepEqual([...connectorIdsOfKind(MODEL, 'mailbox')], ['conn_mail01']);
    assert.deepEqual([...connectorIdsOfKind(null, 'rest')], []);
});
