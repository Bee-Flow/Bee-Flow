/**
 * Route tests for /api/compliance/settings (routes/compliance/settings.js).
 *
 * The auth gate, the org resolver, the runner, the event bus and the store's
 * PERSISTENCE are doubles; `sanitizeSettingsPatch` is the REAL one (the store
 * is loaded by absolute path, past the resolve stub, with `../db` mocked), so
 * what is pinned here is the whole write boundary as a client meets it:
 *
 *   · a body cannot forge the AI Act Art. 50(2) attestation stamp — the route
 *     stamps it, and only when the decision actually changed;
 *   · a body cannot switch a framework on or rewrite `framework_relevance`:
 *     that is frameworkPolicy's licence check, its events and its audit trail;
 *   · a value that does not fit its column — by TYPE, or by the column's own
 *     DOMAIN (an int4 that overflows, a year Postgres cannot store, a NUL no
 *     text or jsonb column can hold) — is a 400 naming the field, with no
 *     submitted value echoed back (BFSF-441), and nothing is written — instead
 *     of a driver error that discarded every other edit of the same submit.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/settings.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { createRecordingDb } = require('../../testUtils/mockDb');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Doubles ────────────────────────────────────────────────────────────────
const calls = { saved: [], evidence: [], events: [], invalidated: [], runAll: [] };

const STORED = {
    organization_id: 'orgA',
    dpo_name: 'Dana',
    enabled_frameworks: ['cra'],
    framework_relevance: { dora: 'not_relevant', meta: { dora: { set_by: 'u9', set_at: '2026-09-01T00:00:00.000Z', note: null } } },
    ai_content_marking_enabled: false,
    ai_content_marking_footer: null,
    ai_content_marking_enabled_at: null,
    ai_content_marking_enabled_by: null,
    public_base_url: null,
};
let stored;

const complianceStore = {
    getSettings: async () => ({ ...stored }),
    saveSettings: async (orgId, patch) => {
        calls.saved.push({ orgId, patch });
        stored = { ...stored, ...patch };
        return { ...stored };
    },
    addEvidence: async (row) => { calls.evidence.push(row); return { id: calls.evidence.length }; },
};

const mockDb = createRecordingDb({ tables: { compliance_settings: [], users: [] } });

const restore = installResolveStub({
    '../db': mockDb.db,                       // for the real store, loaded below
    '../../db': mockDb.db,                    // for the route's own getAll
    '../../stores/complianceStore': complianceStore,
    '../../stores/configStore': { getConfig: async () => ({}) },
    '../../compliance/runner': { runAll: async (orgId, opts) => { calls.runAll.push({ orgId, opts }); return []; }, runOne: async () => [] },
    '../../compliance/marking': { invalidate: (orgId) => calls.invalidated.push(orgId) },
    '../../compliance/events': {
        EVENTS: { CONTENT_MARKING_CHANGED: 'content_marking_changed' },
        emit: (name, payload) => calls.events.push({ name, payload }),
    },
    '../../utils/appPaths': { publicBaseUrl: (o) => o || 'https://app.example.test', publicDsrPath: () => '/dsr' },
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.headers['x-test-user'] ? next() : res.status(401).json({ error: 'Not authenticated' })),
        requirePermission: () => (req, res, next) => next(),
    },
    './shared': { resolveOrgId: async (req) => req.headers['x-test-org'] || 'default' },
});

// The real sanitiser: an absolute request is not in the stub map, so this is
// the file itself (with `../db` mocked out from under it).
const realStore = require(path.join(__dirname, '../../stores/complianceStore.js'));
complianceStore.sanitizeSettingsPatch = realStore.sanitizeSettingsPatch;
complianceStore.SettingsValidationError = realStore.SettingsValidationError;

const router = require('./settings');
test.after(() => restore());

// ── Harness ────────────────────────────────────────────────────────────────
let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = req.headers['x-test-user'] ? { isAuthenticated: true, user: { id: req.headers['x-test-user'] } } : {}; next(); });
    app.use('/api/compliance', router);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });
test.beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k].length = 0;
    stored = { ...STORED };
});

const hdrs = { 'x-test-user': 'u1', 'x-test-org': 'orgA', 'content-type': 'application/json' };
const put = (body) => fetch(`${baseUrl}/api/compliance/settings`, { method: 'PUT', headers: hdrs, body: JSON.stringify(body) });
const onboarded = (body) => fetch(`${baseUrl}/api/compliance/settings/onboarded`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
const lastPatch = () => { assert.equal(calls.saved.length, 1, 'exactly one save'); return calls.saved[0].patch; };

test('PUT: a body cannot forge the content-marking stamp — no write, no evidence, no event', async () => {
    const res = await put({
        ai_content_marking_enabled_by: 'someone-else',
        ai_content_marking_enabled_at: '2020-01-01T00:00:00Z',
        dpo_name: 'Dana',
    });
    assert.equal(res.status, 200);
    const patch = lastPatch();
    assert.ok(!('ai_content_marking_enabled_by' in patch), 'the stamp actor is not patchable');
    assert.ok(!('ai_content_marking_enabled_at' in patch), 'the stamp moment is not patchable');
    assert.deepEqual(patch, { dpo_name: 'Dana' });
    assert.equal(calls.evidence.length, 0, 'no evidence for a change that did not happen');
    assert.equal(calls.events.length, 0, 'no CONTENT_MARKING_CHANGED');
    const body = await res.json();
    assert.equal(body.ai_content_marking_enabled_by, null, 'the stored stamp is untouched');
});

test('PUT: flipping marking on stamps the CALLER and the server clock, even when the body claims otherwise', async () => {
    const before = Date.now();
    const res = await put({
        ai_content_marking_enabled: true,
        ai_content_marking_footer: 'Gemaakt met AI',
        ai_content_marking_enabled_by: 'someone-else',
        ai_content_marking_enabled_at: '2020-01-01T00:00:00Z',
    });
    assert.equal(res.status, 200);
    const patch = lastPatch();
    assert.equal(patch.ai_content_marking_enabled, true);
    assert.equal(patch.ai_content_marking_enabled_by, 'u1', 'the session user, not the body');
    assert.ok(Date.parse(patch.ai_content_marking_enabled_at) >= before, 'the server clock, not 2020');
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].name, 'content_marking_changed');
    assert.deepEqual(calls.invalidated, ['orgA']);
    assert.equal(calls.evidence.length, 1);
    assert.deepEqual(Object.keys(calls.evidence[0].payload).sort(),
        ['action', 'at', 'by', 'enabled', 'footer', 'footer_changed']);
});

test('PUT: a body cannot enable a framework or rewrite the relevance trail (licence bypass)', async () => {
    const res = await put({
        enabled_frameworks: ['cra', 'nis2', 'dora'],
        framework_relevance: { dora: 'relevant' },
        cra_role: 'manufacturer',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(lastPatch(), { cra_role: 'manufacturer' }, 'only the framework-neutral field is written');
    const body = await res.json();
    assert.deepEqual(body.enabled_frameworks, ['cra'], 'nis2/dora are not switched on behind the licence check');
    assert.deepEqual(body.framework_relevance.meta.dora, { set_by: 'u9', set_at: '2026-09-01T00:00:00.000Z', note: null },
        'the relevance audit trail survives');
});

test('PUT: a value that does not fit its column is a 400 naming the fields; the whole save is refused, not silently lost', async () => {
    const res = await put({
        support_end_date: 'soon',
        notice_period_days: 'thirty',
        data_act_provider_role: 'yes',
        dpo_name: 'Dana',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_setting');
    assert.deepEqual(body.fields, [
        { field: 'support_end_date', expected: 'a date (YYYY-MM-DD)' },
        { field: 'data_act_provider_role', expected: 'a boolean' },
        { field: 'notice_period_days', expected: 'an integer' },
    ]);
    const raw = JSON.stringify(body);
    for (const value of ['soon', 'thirty', '"yes"', 'Dana']) {
        assert.ok(!raw.includes(value), `the submitted value ${value} is not echoed back`);
    }
    assert.equal(calls.saved.length, 0, 'nothing is written');
});

test('PUT: well-typed strings are coerced to the column type instead of reaching the driver', async () => {
    const res = await put({ notice_period_days: '60', sso_enforces_mfa: 'true', support_end_date: '2029-12-31' });
    assert.equal(res.status, 200);
    assert.deepEqual(lastPatch(), { sso_enforces_mfa: true, support_end_date: '2029-12-31', notice_period_days: 60 });
});

test('POST /settings/onboarded goes through the same boundary and keeps its own stamp', async () => {
    const res = await onboarded({
        dpo_name: 'Dana',
        enabled_frameworks: ['nis2'],
        ai_content_marking_enabled_by: 'someone-else',
        onboarded_at: '2000-01-01T00:00:00Z',
    });
    assert.equal(res.status, 200);
    const patch = lastPatch();
    assert.equal(patch.dpo_name, 'Dana');
    assert.ok(!('enabled_frameworks' in patch), 'no framework bypass through the wizard either');
    assert.ok(!('ai_content_marking_enabled_by' in patch), 'no forged stamp through the wizard either');
    assert.ok(Date.parse(patch.onboarded_at) > Date.parse('2020-01-01T00:00:00Z'), 'onboarded_at is the route\'s own stamp');
    assert.deepEqual(calls.runAll.map(c => c.orgId), ['orgA']);
});

test('POST /settings/onboarded: a bad value is a 400 too, and the onboarding stamp is not written', async () => {
    const res = await onboarded({ default_retention_days: 'forever' });
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).fields, [{ field: 'default_retention_days', expected: 'an integer' }]);
    assert.equal(calls.saved.length, 0);
    assert.equal(calls.runAll.length, 0, 'no compliance sweep on a refused submit');
});

test('PUT: an integer past its column domain is a 400 naming the field, not a 500 that loses the submit', async () => {
    // 99999999999 is a valid JS integer and a valid int4 overflow: without the
    // domain check it reaches Postgres ("integer out of range"), the whole
    // UPDATE is rejected and every other edit of this submit is gone.
    const res = await put({ notice_period_days: 99999999999, dpo_name: 'Dana', default_retention_days: 4242 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_setting');
    assert.deepEqual(body.fields, [{ field: 'notice_period_days', expected: 'an integer between 0 and 3650' }]);
    // 4242, not 365: the declared bound "0 and 3650" legitimately contains the
    // digits 365, and a probe value must not collide with the expected text.
    const raw = JSON.stringify(body);
    for (const value of ['99999999999', 'Dana', '4242']) {
        assert.ok(!raw.includes(value), `the submitted value ${value} is not echoed back`);
    }
    assert.equal(calls.saved.length, 0, 'nothing is written');
});

test('PUT: a value Postgres would refuse on its own terms is a 400 too — year, NUL, nesting', async () => {
    const NUL = String.fromCharCode(0);
    const cases = [
        [{ support_end_date: '0000-01-01' }, 'support_end_date'],
        [{ nis2_registered_at: '+275760-09-13T00:00:00.000Z' }, 'nis2_registered_at'],
        [{ dpo_name: `Dana${NUL}` }, 'dpo_name'],
        [{ breach_recipients: [`sec@example.test${NUL}`] }, 'breach_recipients'],
    ];
    for (const [body, field] of cases) {
        const res = await put({ ...body, cra_role: 'manufacturer' });
        assert.equal(res.status, 400, `400 for ${field}`);
        const out = await res.json();
        assert.equal(out.error, 'invalid_setting');
        assert.deepEqual(out.fields.map(f => f.field), [field]);
        assert.ok(!JSON.stringify(out).includes('sec@example.test'), 'no submitted value echoed back (BFSF-441)');
    }
    assert.equal(calls.saved.length, 0, 'not one of them reached the store');
});

test('PUT: an in-domain value still saves — the edges are not moved', async () => {
    const res = await put({ notice_period_days: 3650, dora_customer_notice_hours: 0, support_end_date: '9999-12-31' });
    assert.equal(res.status, 200);
    assert.deepEqual(lastPatch(), { notice_period_days: 3650, dora_customer_notice_hours: 0, support_end_date: '9999-12-31' });
});
