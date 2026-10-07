/**
 * LEDGER_ORG_SQL and the integration_activity_log readers that use it, against
 * a real Postgres (@electric-sql/pglite, in-process).
 *
 * logToolEgress writes `organization_id` NULL (or '') for a user without an
 * organisation, which on a single-tenant install is every user, and the
 * scheduler sweeps that install as the 'default' bucket. Proven here: the
 * predicate gives 'default' its own rows plus the org-less ones and gives a
 * real org only its own; and ISO A.5.20, the RoPA processor list and the
 * AI Act Art. 26(6) integration ledger all run their actual SQL through it.
 *
 * Run: cd server && node --test stores/integrationLocationSql.ledgerOrg.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { installResolveStub } = require('../testUtils/stubRequire');
const { LEDGER_ORG_SQL } = require('./integrationLocationSql');

const pg = new PGlite();
const run = async (sql, params) => (params && params.length ? pg.query(sql, params) : pg.query(sql));
const fakeDb = {
    getAll: async (sql, params) => (await run(sql, params)).rows,
    getOne: async (sql, params) => (await run(sql, params)).rows[0] || null,
};

const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async () => ({ scc_confirmed_operators: [] }) },
});
const a520 = require('../compliance/checks/iso27001/a5-20-suppliers');
const art266 = require('../compliance/checks/aia/art26-6-log-retention');
const { ledgerProcessors } = require('../compliance/ropa/ledgerProcessors');

// The columns the ledger fragments (SUPPLIER_ROW, NON_EU, LOC_STATE) read.
const DDL = `
    CREATE TABLE integration_activity_log (
        id SERIAL PRIMARY KEY,
        organization_id TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        operator TEXT,
        is_eu BOOLEAN,
        is_local BOOLEAN,
        is_dry_run BOOLEAN,
        location_state TEXT,
        peer_ip TEXT,
        server_ip TEXT,
        server_endpoint TEXT,
        country_code TEXT,
        country_name TEXT
    );
    CREATE TABLE guardrail_events (id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL);
`;

/** org, operator, age in days, EU or not. */
const ROWS = [
    ['org1', 'Mistral', 10, true],
    [null, 'OpenAI', 200, false],
    ['', 'Anthropic', 5, false],
    ['default', 'Scaleway', 3, true],
    ['org2', 'Google', 1, false],
];

before(async () => {
    await pg.exec(DDL);
    for (const [org, operator, ageDays, eu] of ROWS) {
        await pg.query(`
            INSERT INTO integration_activity_log
                (organization_id, timestamp, operator, is_eu, is_local, is_dry_run, location_state, peer_ip, server_endpoint, country_code)
            VALUES ($1, NOW() - ($2::int * INTERVAL '1 day'), $3, $4, false, false, $5, '203.0.113.7', 'api.example', $6)
        `, [org, ageDays, operator, eu, eu ? 'eu' : 'outside', eu ? 'FR' : 'US']);
    }
});
after(async () => { restore(); await pg.close(); });

async function operatorsSeenBy(orgId) {
    const { rows } = await pg.query(`SELECT operator FROM integration_activity_log WHERE ${LEDGER_ORG_SQL} ORDER BY operator`, [orgId]);
    return rows.map(r => r.operator);
}

test('the predicate: "default" owns its own rows plus the NULL and empty ones', async () => {
    assert.deepEqual(await operatorsSeenBy('default'), ['Anthropic', 'OpenAI', 'Scaleway']);
});

test('the predicate: a real org sees only its own rows, never the org-less ones', async () => {
    assert.deepEqual(await operatorsSeenBy('org1'), ['Mistral']);
    assert.deepEqual(await operatorsSeenBy('org2'), ['Google']);
    assert.deepEqual(await operatorsSeenBy('org-without-traffic'), []);
});

test('ISO A.5.20: the default bucket reconciles the suppliers its org-less users reached', async () => {
    const r = await a520.evaluate('default');
    // OpenAI is outside the 30-day window.
    assert.deepEqual(r.evidence.operators_observed.map(o => o.operator).sort(), ['Anthropic', 'Scaleway']);
    const org1 = await a520.evaluate('org1');
    assert.deepEqual(org1.evidence.operators_observed.map(o => o.operator), ['Mistral']);
});

test('RoPA: the default bucket lists the processors its org-less users reached', async () => {
    const rows = await ledgerProcessors('default');
    // OpenAI is outside the 180-day window.
    assert.deepEqual(rows.map(p => p.operator).sort(), ['Anthropic', 'Scaleway']);
    const anthropic = rows.find(p => p.operator === 'Anthropic');
    assert.equal(anthropic.outside_calls, 1, 'the located non-EU call counts as a transfer');
    assert.deepEqual((await ledgerProcessors('org1')).map(p => p.operator), ['Mistral']);
});

test('AI Act Art. 26(6): the default bucket\'s integration ledger span includes the org-less rows', async () => {
    const r = await art266.evaluate('default');
    assert.ok(r.evidence.integration_log_span_days >= 199, `span ${r.evidence.integration_log_span_days} must reach the 200-day-old org-less row`);
    assert.equal(r.status, 'pass');
    const org1 = await art266.evaluate('org1');
    assert.ok(org1.evidence.integration_log_span_days < 11, 'a real org never inherits the org-less rows');
});
