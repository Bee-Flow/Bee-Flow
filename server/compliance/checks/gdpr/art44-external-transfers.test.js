/**
 * GDPR Art. 44: the ledger query itself — what it reads, in which order it
 * keeps rows under its LIMIT, and where it sends the admin. The decision over
 * the rows is compliance/lib/transferAssessment.js and tested there.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art44-external-transfers.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { rows: [], sql: null, params: null };
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async getAll(sql, params) {
        if (/integration_activity_log/.test(sql)) {
            state.sql = flat(sql);
            state.params = params;
            return state.rows;
        }
        if (/FROM agents/.test(sql)) {
            state.agentSql = flat(sql);
            state.agentParams = params;
            // Ignores the parameters on purpose: the JS mirror must hold alone.
            return state.agents || [];
        }
        return [];
    },
    async getOne() { return null; },
    async run() { return { rowCount: 0 }; },
    async exec() {},
};

// The check requires '../../../db', '../../../stores/configStore' and
// '../../../stores/complianceStore'; observedOperators (for the org filter)
// requires '../../db' and '../../stores/configStore'.
const fakeConfigStore = { async getConfig() { return null; } };
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../db': fakeDb,
    '../../../stores/configStore': fakeConfigStore,
    '../../stores/configStore': fakeConfigStore,
    '../../../stores/complianceStore': { async getSettings() { return { scc_confirmed_operators: [] }; } },
});
const check = require('./art44-external-transfers');
test.after(() => restore());

test.beforeEach(() => { state.rows = []; state.sql = null; state.params = null; });

test('transfers are ordered first, so the LIMIT can never drop an unattested one', async () => {
    await check.evaluate('orgA');
    assert.match(state.sql, /ORDER BY CASE[\s\S]*'outside' THEN 0[\s\S]*calls DESC/);
    assert.match(state.sql, new RegExp(`LIMIT ${check.TRANSFER_GROUP_LIMIT + 1}\\b`));
    assert.equal(check.TRANSFER_GROUP_LIMIT, 1000);
});

test('a cut is flagged in the evidence, and the rows past the limit are not assessed', async () => {
    const located = { operator: 'Hetzner', location_state: 'eu', is_eu: true, calls: 1 };
    state.rows = [
        { operator: 'Amazon AWS', location_state: 'outside', country_code: 'US', calls: 2 },
        ...Array.from({ length: check.TRANSFER_GROUP_LIMIT }, () => located),
    ];
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'fail', 'the transfer at the top survives the cut');
    assert.equal(r.evidence.groups_truncated, true);
    assert.equal(r.evidence.transfers_total, check.TRANSFER_GROUP_LIMIT);

    state.rows = [located];
    assert.equal((await check.evaluate('orgA')).evidence.groups_truncated, false);
});

test('a single-tenant install: the default bucket reads the ledger rows written with no organisation', async () => {
    await check.evaluate('default');
    assert.deepEqual(state.params, ['default']);
    assert.match(state.sql, /WHERE \(organization_id = \$1 OR \(\$1::text = 'default' AND \(organization_id IS NULL OR organization_id = ''\)\)\)/);
});

test('the remediation link lands on the processing register, where the SCC toggle is', () => {
    assert.equal(check.remediationLink, 'admin/compliance/ropa');
});

test('an agent without an organisation counts for the default bucket only, never for every tenant', async () => {
    // The fallback scan kept every org-less agent for every organisation, so
    // tenant A's legacy agent appeared by name in tenant B's external_agents.
    // Only org-less users see such an agent, and the scheduler sweeps them as
    // 'default' (same convention as AIA Art. 13, 50 and 53).
    state.agents = [
        { id: 'x', name: 'Legacy agent', model: 'openai/gpt-4o', organization_id: null },
        { id: 'e', name: 'Empty org', model: 'openai/gpt-4o', organization_id: '' },
        { id: 'b', name: 'Org B agent', model: 'openai/gpt-4o', organization_id: 'orgB' },
    ];
    try {
        const a = await check.evaluate('orgA');
        assert.equal(a.status, 'not_applicable', 'orgA has no agent of its own');
        assert.deepEqual(state.agentParams, ['orgA']);
        assert.match(state.agentSql, /FROM agents WHERE is_published = TRUE AND COALESCE\(NULLIF\(organization_id, ''\), 'default'\) = \$1/);
        assert.deepEqual((await check.evaluate('default')).evidence.external_agents.map((x) => x.id), ['x', 'e']);
        assert.deepEqual((await check.evaluate('orgB')).evidence.external_agents.map((x) => x.id), ['b']);
    } finally {
        state.agents = [];
    }
});
