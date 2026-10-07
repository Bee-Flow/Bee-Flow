/**
 * GDPR Art. 28 after the move onto lib/observedOperators: the SQL the ledger
 * query runs is byte-for-byte the query this check has always run, and the
 * status ladder is unchanged — no ledger → n/a, quiet ledger → n/a, an
 * unattested operator → warn, all attested → pass. Plus the cross-framework
 * tags the SoA / NIS2 / DORA joins rely on.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/gdpr/art28-subprocessors.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { rows: [], queryError: null, settings: {}, lastSql: null, lastParams: null };
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async getAll(sql, params) {
        state.lastSql = flat(sql);
        state.lastParams = params;
        if (state.queryError) throw state.queryError;
        return state.rows;
    },
    async getOne() { return null; },
    async run() { return { rowCount: 0 }; },
    async exec() {},
};
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeConfigStore = { async getConfig() { return null; } };

// observedOperators requires '../../db' and '../../stores/configStore'; the
// check requires '../../../stores/complianceStore'.
const restore = installResolveStub({
    '../../db': fakeDb,
    '../../stores/configStore': fakeConfigStore,
    '../../../stores/complianceStore': fakeComplianceStore,
});
const check = require('./art28-subprocessors');
test.after(() => restore());

test.beforeEach(() => {
    state.rows = [];
    state.queryError = null;
    state.settings = { scc_confirmed_operators: [] };
    state.lastSql = null;
});

test('module shape and cross-framework tags', () => {
    assert.equal(check.id, 'GDPR-Art28-subprocessors');
    assert.equal(check.regulation, 'GDPR');
    assert.equal(check.article, '28');
    assert.equal(check.verification, 'automated');
    assert.equal(check.remediationLink, 'admin/compliance/ropa');
    assert.deepEqual(check.frameworks, [
        { regulation: 'ISO27001', ref: 'A.5.20' },
        { regulation: 'NIS2', ref: 'Art. 21(2)(d)' },
        { regulation: 'DORA', ref: 'Art. 28(3)' },
    ]);
});

test('the ledger query is unchanged: 30-day window, org-scoped, local and dry-run calls excluded', async () => {
    await check.evaluate('org-1');
    assert.deepEqual(state.lastParams, ['org-1']);
    assert.match(state.lastSql, /FROM integration_activity_log WHERE \(organization_id = \$1 OR \(\$1::text = 'default' AND \(organization_id IS NULL OR organization_id = ''\)\)\)/);
    assert.match(state.lastSql, /INTERVAL '30 days'/);
    assert.match(state.lastSql, /COALESCE\(is_local, false\) = false/);
    assert.match(state.lastSql, /COALESCE\(is_dry_run, false\) = false/);
    assert.match(state.lastSql, /GROUP BY COALESCE\(operator, 'unknown'\)/);
    assert.doesNotMatch(state.lastSql, /country_code/, 'Art. 28 does not ask for the country column');
});

test('no ledger table → not_applicable with the historical reason', async () => {
    state.queryError = Object.assign(new Error('relation "integration_activity_log" does not exist'), { code: '42P01' });
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { reason: 'activity ledger not available' });
});

test('a single-tenant install: the default bucket reads the ledger rows written with no organisation', async () => {
    // logToolEgress writes organization_id NULL for a user with no org, while
    // the scheduler sweeps that install as 'default'. The parameter stays the
    // org id; the predicate maps NULL/'' onto 'default' only.
    await check.evaluate('default');
    assert.deepEqual(state.lastParams, ['default']);
    assert.match(state.lastSql, /organization_id IS NULL OR organization_id = ''/);
});

test('a ledger that cannot be read → warn with the SQLSTATE, not "no ledger yet"', async () => {
    // not_applicable leaves the score, so a timeout used to look like a fresh
    // install. Only 42P01/42703 mean "not provisioned".
    state.queryError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.sqlstate, '57014');
    assert.ok(!JSON.stringify(r).includes('canceling statement'), 'the raw error message stays out of the evidence');
});

test('a quiet ledger → not_applicable', async () => {
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { operators: [] });
});

test('an observed operator without an attestation → warn, named in evidence and details', async () => {
    state.rows = [
        { operator: 'OpenAI', is_eu: false, calls: 12 },
        { operator: 'Scaleway', is_eu: true, calls: 3 },
    ];
    state.settings = { scc_confirmed_operators: [{ operator: 'openai', attested_by: 'u1', attested_at: '2026-01-01T00:00:00Z' }] };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.window_days, 30);
    assert.deepEqual(r.evidence.uncovered, ['Scaleway']);
    assert.deepEqual(r.evidence.attested_operators, ['openai']);
    assert.equal(r.evidence.operators_observed.length, 2);
    assert.match(r.details, /1 observed processor\(s\) \(Scaleway\)/);
    assert.ok(!/@/.test(JSON.stringify(r)), 'operators are companies — no e-mail address anywhere');
});

test('every observed operator attested (case-insensitive) → pass', async () => {
    state.rows = [{ operator: 'OpenAI', is_eu: false, calls: 12 }, { operator: 'unknown', is_eu: false, calls: 1 }];
    state.settings = { scc_confirmed_operators: [{ operator: 'OPENAI' }, { operator: 'Unknown' }, { operator: '' }, null] };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.uncovered, []);
    assert.match(r.details, /All 2 observed processor\(s\)/);
});

test('a malformed attestation list is treated as empty', async () => {
    state.rows = [{ operator: 'OpenAI', is_eu: false, calls: 1 }];
    state.settings = { scc_confirmed_operators: 'not-an-array' };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
});
