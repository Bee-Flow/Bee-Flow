/**
 * Art-44 assessment by location state: outside fails unattested, via_network
 * warns at most, unknown is not a transfer but warns above 5 % of the calls.
 *
 * Run: node --test server/compliance/lib/transferAssessment.test.js
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assessTransfers, rowState } = require('./transferAssessment');

const row = (operator, location_state, calls, extra = {}) => ({ operator, location_state, calls, is_eu: location_state === 'eu', is_local: location_state === 'local', ...extra });

test('outside without an attestation fails; attested passes', () => {
    const rows = [row('Amazon AWS', 'outside', 10, { country_code: 'US' }), row(null, 'local', 90)];
    assert.equal(assessTransfers(rows, new Set()).status, 'fail');
    const ok = assessTransfers(rows, new Set(['amazon aws']));
    assert.equal(ok.status, 'pass');
    assert.equal(ok.evidence.non_eu_confirmed.length, 1);
});

test('via_network is its own list and at most a warn', () => {
    const rows = [row('Cloudflare', 'via_network', 30, { country_code: 'NL' }), row('Hetzner', 'eu', 70)];
    const r = assessTransfers(rows, new Set());
    assert.equal(r.status, 'warn', 'never a fail');
    assert.equal(r.evidence.via_network.length, 1);
    assert.equal(r.evidence.non_eu_unconfirmed.length, 0, 'not counted as a transfer');
    assert.match(r.details, /Cloudflare/);
    assert.equal(assessTransfers(rows, new Set(['cloudflare'])).status, 'pass', 'attested network passes');
    // An outside transfer still fails when a network row is present.
    assert.equal(assessTransfers([...rows, row('X', 'outside', 1)], new Set()).status, 'fail');
});

test('unknown is not a transfer; above 5 % of calls it warns', () => {
    const few = [row(null, 'unknown', 5), row('Hetzner', 'eu', 95)];
    const r1 = assessTransfers(few, new Set());
    assert.equal(r1.status, 'pass', 'exactly 5 % is fine');
    assert.equal(r1.evidence.unlocated_calls, 5);
    assert.equal(r1.evidence.unlocated_pct, 5);
    const many = [row(null, 'unknown', 2907), row(null, 'local', 461), row('Cloudflare', 'via_network', 39)];
    const r2 = assessTransfers(many, new Set(['cloudflare']));
    assert.equal(r2.status, 'warn');
    assert.match(r2.details, /no known location/);
    assert.equal(r2.evidence.non_eu_unconfirmed.length, 0, 'the private Nextcloud rows are not a transfer');
});

test('rows without location_state fall back on the old flags', () => {
    assert.equal(rowState({ is_local: true }), 'local');
    assert.equal(rowState({ is_eu: true }), 'eu');
    assert.equal(rowState({}), 'outside');
    const r = assessTransfers([{ operator: 'openai', is_eu: false, is_local: false, calls: 12 }], new Set());
    assert.equal(r.status, 'fail');
});

test('the fail counts operators, not operator × country rows, and claims "data", not "personal data"', () => {
    // The ledger rows are grouped per operator AND country, and the art44
    // query has no PII filter: one operator in two countries used to read
    // "2 operator(s) routed personal data".
    const rows = [
        { operator: 'Amazon AWS', location_state: 'outside', country_code: 'US', calls: 5 },
        { operator: 'Amazon AWS', location_state: 'outside', country_code: 'SG', calls: 3 },
    ];
    const r = assessTransfers(rows, new Set());
    assert.equal(r.status, 'fail');
    assert.match(r.details, /^1 operator\(s\)/);
    assert.doesNotMatch(r.details, /personal data/);
    assert.equal(r.evidence.non_eu_unconfirmed_operators, 1);
    // The SCC toggle is on the processing register, not on Settings.
    assert.match(r.details, /Compliance → Processing register/);
    assert.doesNotMatch(r.details, /Compliance → Settings/);

    const ok = assessTransfers(rows, new Set(['amazon aws']));
    assert.equal(ok.status, 'pass');
    assert.match(ok.details, /^1 non-EU operator\(s\) in use/);
});
