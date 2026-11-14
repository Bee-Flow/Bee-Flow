/**
 * GDPR Art. 44: the ledger query itself — what it reads, in which order it
 * keeps rows under its LIMIT, and where it sends the admin. The decision over
 * the rows is compliance/lib/transferAssessment.js and tested there. The
 * ledger is a real Postgres.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art44-external-transfers.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { insertRow } = require('../../../testUtils/pgliteSeed');

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind
// db.js's pool. No AI providers are configured: configStore is replaced on the
// singleton, so only the ledger and the agents speak.
const { pg, close } = usePglitePool(ladderPglite());
const configStore = require('../../../stores/configStore');
configStore.getConfig = async () => null;
const check = require('./art44-external-transfers');
test.after(close);

test.beforeEach(() => pg.exec('DELETE FROM integration_activity_log; DELETE FROM agents; DELETE FROM compliance_settings'));

/**
 * `n` calls of one group: an operator in a location.
 * @param {Record<string, unknown>} row
 * @param {number} [n]
 */
async function ledger(row, n = 1) {
    for (let i = 0; i < n; i++) {
        await insertRow(pg, 'integration_activity_log', { tool_name: 'llm', organization_id: 'orgA', served_from_cache: false, ...row });
    }
}
const AWS = { operator: 'Amazon AWS', location_state: 'outside', country_code: 'US', is_eu: false, is_local: false };

test('transfers are ordered first, so the LIMIT can never drop an unattested one', async () => {
    assert.equal(check.TRANSFER_GROUP_LIMIT, 1000);
    // One small transfer and more busier EU groups than the LIMIT keeps: the transfer is still kept.
    await ledger(AWS);
    await pg.query(`INSERT INTO integration_activity_log (tool_name, organization_id, operator, location_state, is_eu, is_local, served_from_cache)
        SELECT 'llm', 'orgA', 'EU host ' || g, 'eu', true, false, false FROM generate_series(1, $1) g, generate_series(1, 2)`, [check.TRANSFER_GROUP_LIMIT + 1]);
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'fail', 'the transfer at the top survives the cut');
    assert.equal(r.evidence.groups_truncated, true);
});

test('a cut is flagged in the evidence; under the limit it is not', async () => {
    await ledger(AWS);
    await pg.query(`INSERT INTO integration_activity_log (tool_name, organization_id, operator, location_state, is_eu, is_local, served_from_cache)
        SELECT 'llm', 'orgA', 'EU host ' || g, 'eu', true, false, false FROM generate_series(1, $1) g`, [check.TRANSFER_GROUP_LIMIT]);
    const r = await check.evaluate('orgA');
    assert.equal(r.evidence.groups_truncated, true);
    assert.equal(r.evidence.transfers_total, check.TRANSFER_GROUP_LIMIT);

    await pg.exec('DELETE FROM integration_activity_log');
    await ledger({ operator: 'Hetzner', location_state: 'eu', is_eu: true });
    assert.equal((await check.evaluate('orgA')).evidence.groups_truncated, false);
});

test('a cache hit, an old call and another tenant\'s call are no transfer of this organisation', async () => {
    await ledger({ ...AWS, served_from_cache: true });
    await ledger({ ...AWS, timestamp: new Date(Date.now() - 40 * 86400e3).toISOString() });
    await ledger({ ...AWS, organization_id: 'orgB' });
    await ledger({ operator: 'Hetzner', location_state: 'eu', is_eu: true });
    const r = await check.evaluate('orgA');
    assert.notEqual(r.status, 'fail');
    assert.equal(r.evidence.transfers_total, 1, 'only the EU call');
});

test('a single-tenant install: the default bucket reads the ledger rows written with no organisation', async () => {
    await ledger({ ...AWS, organization_id: null });
    await ledger({ ...AWS, organization_id: '' });
    assert.equal((await check.evaluate('default')).status, 'fail');
    assert.notEqual((await check.evaluate('orgA')).status, 'fail', 'never a tenant\'s');
});

test('the remediation link lands on the processing register, where the SCC toggle is', () => {
    assert.equal(check.remediationLink, 'admin/compliance/ropa');
});

test('an agent without an organisation counts for the default bucket only, never for every tenant', async () => {
    // The fallback scan kept every org-less agent for every organisation, so
    // tenant A's legacy agent appeared by name in tenant B's external_agents.
    // Only org-less users see such an agent, and the scheduler sweeps them as
    // 'default' (same convention as AIA Art. 13, 50 and 53).
    for (const [id, name, org] of [['x', 'Legacy agent', null], ['e', 'Empty org', ''], ['b', 'Org B agent', 'orgB']]) {
        await insertRow(pg, 'agents', { id, name, owner_id: 'o', model: 'openai/gpt-4o', organization_id: org, is_published: true });
    }
    const a = await check.evaluate('orgA');
    assert.equal(a.status, 'not_applicable', 'orgA has no agent of its own');
    assert.deepEqual((await check.evaluate('default')).evidence.external_agents.map((x) => x.id).sort(), ['e', 'x']);
    assert.deepEqual((await check.evaluate('orgB')).evidence.external_agents.map((x) => x.id), ['b']);
});
