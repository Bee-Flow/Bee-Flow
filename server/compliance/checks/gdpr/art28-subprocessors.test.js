// @typecheck
/**
 * GDPR Art. 28 on lib/observedOperators: the ledger query reads what it
 * always read (on a real Postgres), and the status ladder is unchanged — no ledger → n/a, quiet ledger → n/a, an
 * unattested operator → warn, all attested → pass. Plus the cross-framework
 * tags the SoA / NIS2 / DORA joins rely on.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art28-subprocessors.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const state = { settings: {} };

// The ledger runs on the boot ladder's schema on PGlite
// (testUtils/pgliteTemplate.js) behind db.js's pool; no AI providers are
// configured (configStore replaced on the singleton). The settings are
// stubbed: the attestation lists under test include malformed ones the
// settings store would not save.
const { pg, close } = usePglitePool(ladderPglite());
const configStore = require('../../../stores/configStore');
configStore.getConfig = async () => null;
const restore = installResolveStub({
    '../../../stores/complianceStore': { async getSettings() { return state.settings; } },
});
const check = require('./art28-subprocessors');
test.after(async () => { restore(); await close(); });

test.beforeEach(async () => {
    state.settings = { scc_confirmed_operators: [] };
    await pg.exec('DELETE FROM integration_activity_log');
});

/**
 * `n` calls to `operator`, by org-1 unless the row says otherwise.
 * @param {string | null} operator @param {number} [n] @param {Record<string, unknown>} [over]
 */
async function calls(operator, n = 1, over = {}) {
    for (let i = 0; i < n; i++) {
        await insertRow(pg, 'integration_activity_log', { tool_name: 'llm', organization_id: 'org-1', operator, is_eu: false, ...over });
    }
}

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

test('the ledger: 30-day window, org-scoped, local and dry-run calls excluded, one row per operator', async () => {
    await calls('Old Host', 1, { timestamp: new Date(Date.now() - 40 * 86400e3).toISOString() });
    await calls('Other Tenant Host', 1, { organization_id: 'org-2' });
    await calls('Local Box', 1, { is_local: true });
    await calls('Dry Run Host', 1, { is_dry_run: true });
    assert.equal((await check.evaluate('org-1')).status, 'not_applicable', 'none of those is an observed processor of org-1');
    await calls('OpenAI', 3);
    await calls(null, 2, { location_state: 'outside' });   // located, operator unknown
    await calls(null, 4);                                    // neither operator nor location: names nobody
    const r = await check.evaluate('org-1');
    const observed = Object.fromEntries(r.evidence.operators_observed.map((o) => [o.operator, o.calls]));
    assert.deepEqual(observed, { OpenAI: 3, unknown: 2 });
});

test('no ledger table → not_applicable with the historical reason', async () => {
    const show = await hideTable(pg, 'integration_activity_log');
    let r;
    try { r = await check.evaluate('org-1'); } finally { await show(); }
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { reason: 'activity ledger not available' });
});

test('a single-tenant install: the default bucket reads the ledger rows written with no organisation', async () => {
    // logToolEgress writes organization_id NULL for a user with no org, while
    // the scheduler sweeps that install as 'default'. The parameter stays the
    // org id; the predicate maps NULL/'' onto 'default' only.
    await calls('OpenAI', 1, { organization_id: null });
    await calls('Mistral', 1, { organization_id: '' });
    const r = await check.evaluate('default');
    assert.deepEqual(r.evidence.uncovered.sort(), ['Mistral', 'OpenAI']);
    assert.equal((await check.evaluate('org-1')).status, 'not_applicable', 'never a tenant\'s');
});

test('a ledger that cannot be read → warn with the SQLSTATE, not "no ledger yet"', async () => {
    // not_applicable leaves the score, so a timeout used to look like a fresh
    // install. Only 42P01/42703 mean "not provisioned".
    const undo = await failReads(pg, 'integration_activity_log', '57014', 'canceling statement due to statement timeout');
    let r;
    try { r = await check.evaluate('org-1'); } finally { await undo(); }
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
    await calls('OpenAI', 12);
    await calls('Scaleway', 3, { is_eu: true });
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
    await calls('OpenAI', 12);
    await calls(null, 1, { location_state: 'outside' });
    state.settings = { scc_confirmed_operators: [{ operator: 'OPENAI' }, { operator: 'Unknown' }, { operator: '' }, null] };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.uncovered, []);
    assert.match(r.details, /All 2 observed processor\(s\)/);
});

test('a malformed attestation list is treated as empty', async () => {
    await calls('OpenAI', 1);
    state.settings = { scc_confirmed_operators: 'not-an-array' };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
});
