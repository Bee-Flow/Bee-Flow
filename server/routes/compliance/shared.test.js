/**
 * routes/compliance/shared.js — the helpers more than one sub-router depends
 * on. `activeResultsFilter` is the documented rule "a disabled framework's
 * rows stay in history and are filtered at READ time"; until this file nothing
 * exercised it (review finding M8), even though /checks, /overview and the
 * audit pack all read through it.
 *
 * Doubles go in through installResolveStub; `compliance/registry` is poked by
 * resolved filename so every spelling of the require gets the same fake.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/shared.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installResolveStub } = require('../../testUtils/stubRequire');

const DEFS = {
    'GDPR-Art32-dlp-enabled': { id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', severity: 'critical', frameworks: [{ regulation: 'GDPR', ref: 'Art. 32' }] },
    'GDPR-Art33-breach-notification': { id: 'GDPR-Art33-breach-notification', regulation: 'GDPR', severity: 'high', frameworks: [{ regulation: 'GDPR', ref: 'Art. 33' }, { regulation: 'ISO27001', ref: 'A.5.24' }] },
    'NIS2-Art21(2)(j)-admin-mfa': { id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', severity: 'high', frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(j)' }] },
    'ISO27001-A.5.20-supplier-agreements': { id: 'ISO27001-A.5.20-supplier-agreements', regulation: 'ISO27001', severity: 'medium', frameworks: [], controls: ['A.5.20'] },
};
const registry = { get: (id) => DEFS[id] || null, getAll: () => Object.values(DEFS) };

const registryPath = require.resolve(path.join(__dirname, '../../compliance/registry.js'));
require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: registry };

let ACTIVE = new Set(['GDPR', 'ISO27001']);
const policyCalls = [];
const frameworkPolicy = {
    activeRegulations: async (orgId, opts) => { policyCalls.push({ orgId, opts }); return ACTIVE; },
};

const users = { u1: { id: 'u1', organizationId: 'orgA' }, 'u-orgless': { id: 'u-orgless' } };
const userStore = {
    getUser: async (id) => {
        if (id === 'u-boom') throw new Error('users table gone');
        return users[id] || null;
    },
};

const restore = installResolveStub({
    '../../stores/complianceStore': { getLatestPerCheck: async () => [], getScoreHistory: async () => [], getSettings: async () => ({}) },
    '../../stores/soaStore': { getStats: async () => null },
    '../../stores/ismsDocStore': { listDocs: async () => [] },
    '../../stores/userStore': userStore,
    // Spelled from auth/orgScope.js, which is where the org read actually
    // happens now. installResolveStub keys on the request string as written,
    // so the other spelling would quietly load the real store.
    '../stores/userStore': userStore,
    '../../compliance/frameworkPolicy': frameworkPolicy,
});

const shared = require('./shared');
test.after(() => restore());
test.beforeEach(() => { policyCalls.length = 0; ACTIVE = new Set(['GDPR', 'ISO27001']); });

// ── activeResultsFilter ────────────────────────────────────────────────────

test('activeResultsFilter keeps rows of ACTIVE frameworks and drops a disabled framework\'s history', async () => {
    const isActive = await shared.activeResultsFilter('orgA', { req: { marker: 1 } });
    assert.deepEqual(policyCalls, [{ orgId: 'orgA', opts: { req: { marker: 1 } } }],
        'the request is handed on — the policy cache is per-request, not global');

    assert.equal(isActive({ check_id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', status: 'fail' }), true);
    assert.equal(isActive({ check_id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', status: 'fail' }), false,
        'the stale row of a framework that was disabled since must not surface');

    // Filtering is READ-time only: the row itself is untouched, and the same
    // filter says yes the moment the framework is enabled again.
    ACTIVE = new Set(['GDPR', 'ISO27001', 'NIS2']);
    const afterEnable = await shared.activeResultsFilter('orgA');
    assert.equal(afterEnable({ check_id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2' }), true,
        'nothing was deleted — re-enabling the framework brings its history back');
});

test('activeResultsFilter decides on the CHECK\'s home regulation, not on the row\'s column', async () => {
    const isActive = await shared.activeResultsFilter('orgA');
    // A row that claims a regulation its check does not have: the registry wins.
    // (Rows written before a check moved regulation are exactly this shape.)
    assert.equal(isActive({ check_id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'GDPR' }), false,
        'a NIS2 check does not become visible by carrying GDPR in its column');
    assert.equal(isActive({ check_id: 'GDPR-Art33-breach-notification', regulation: 'NIS2' }), true);
});

test('activeResultsFilter falls back to the row column for a check the registry no longer knows', async () => {
    const isActive = await shared.activeResultsFilter('orgA');
    assert.equal(isActive({ check_id: 'GDPR-Art7-retired', regulation: 'GDPR' }), true, 'retired check, active regulation');
    assert.equal(isActive({ check_id: 'NIS2-Art99-retired', regulation: 'NIS2' }), false, 'retired check, disabled regulation');
    // Neither the registry nor the row says which regulation this is. Hiding it
    // would silently drop evidence, so the documented choice is to keep it.
    assert.equal(isActive({ check_id: 'mystery', regulation: null }), true, 'an unattributable row is kept, not hidden');
    assert.equal(isActive({ check_id: 'mystery' }), true);
    assert.equal(isActive(null), false, 'a missing row is not a visible row');
    assert.equal(isActive(undefined), false);
});

// ── org resolution ─────────────────────────────────────────────────────────

test('resolveOrgId: session org, the legacy `default` fallback, and a store failure that is not a crash', async () => {
    assert.equal(await shared.resolveOrgId({ session: { user: { id: 'u1' } } }), 'orgA');
    assert.equal(await shared.resolveOrgId({}), 'default', 'no session');
    assert.equal(await shared.resolveOrgId({ session: { user: { id: 'u-orgless' } } }), 'default', 'user without an org');
    assert.equal(await shared.resolveOrgId({ session: { user: { id: 'u-boom' } } }), 'default', 'store error');
});

test('resolveOrgIdStrict/requireOrgId refuse instead of falling back to `default`', async () => {
    assert.equal(await shared.resolveOrgIdStrict({ session: { user: { id: 'u1' } } }), 'orgA');
    assert.equal(await shared.resolveOrgIdStrict({ session: { user: { id: 'u-orgless' } } }), null,
        'the strict form never invents the shared `default` org for an org-less session');
    assert.equal(await shared.resolveOrgIdStrict({ session: { user: { id: 'u-boom' } } }), null);

    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    assert.equal(await shared.requireOrgId({ session: { user: { id: 'u-orgless' } } }, res), null);
    assert.equal(res.code, 403);
    assert.deepEqual(res.body, { error: 'no_organisation' });

    const res2 = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
    assert.equal(await shared.requireOrgId({ session: { user: { id: 'u1' } } }, res2), 'orgA');
    assert.equal(res2.code, null, 'nothing is sent on the happy path');
});

// ── the vocabulary the overview and the report share ───────────────────────

test('computeVerificationSummary splits on how a check is VERIFIED and excludes not_applicable', async () => {
    const s = shared.computeVerificationSummary([
        { check_id: 'GDPR-Art32-dlp-enabled', status: 'pass' },            // no `verification` on the def → automated
        { check_id: 'GDPR-Art33-breach-notification', status: 'fail' },
        { check_id: 'ISO27001-A.5.20-supplier-agreements', status: 'not_applicable' },
        { check_id: 'unknown-check', status: 'pass' },                     // unknown → automated
    ]);
    assert.deepEqual(s.automated, { total: 3, pass: 2 });
    assert.deepEqual(s.attestation, { total: 0, pass: 0 });
    assert.deepEqual(s.hybrid, { total: 0, pass: 0 });
});

test('checksByFrameworkRef indexes by ref per regulation, and keeps the legacy ISO `controls` route in', () => {
    const iso = shared.checksByFrameworkRef('ISO27001');
    assert.deepEqual(iso['A.5.24'], ['GDPR-Art33-breach-notification'], 'a GDPR check is ISO A.5.24 evidence');
    assert.deepEqual(iso['A.5.20'], ['ISO27001-A.5.20-supplier-agreements'], 'legacy `controls: []` still indexes');
    assert.equal('Art. 32' in iso, false, 'a GDPR ref does not leak into the ISO index');

    const gdpr = shared.checksByFrameworkRef('GDPR');
    assert.deepEqual(gdpr['Art. 32'], ['GDPR-Art32-dlp-enabled']);
    assert.deepEqual(shared._isoChecksByControl()['A.5.24'], ['GDPR-Art33-breach-notification'], 'the alias is the same index');
});
