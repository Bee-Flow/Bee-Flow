/**
 * A.5.28 on the evidence chain: the check gates on verifyChain's report —
 * fail on a break, warn when there is nothing to verify (columns pending,
 * chain not started, ledger unreachable, malformed pre-chain fingerprints,
 * stale head), pass otherwise. `db` is mocked via require.cache so the walk
 * runs over in-memory rows.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/iso27001/a5-28-evidence-integrity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 86400000;

// ── in-memory compliance_evidence, dispatched by query shape ─────────────────
let rows = [];
let dbError = null; // thrown by every query when set
const calls = { getOne: [], getAll: [] };

const fakeDb = {
    async getOne(sql, params) {
        calls.getOne.push({ sql, params });
        if (dbError) throw dbError;
        assert.match(sql, /COUNT\(\*\)/);
        const mine = rows.filter(r => r.organization_id === params[0]);
        const pre = mine.filter(r => r.seq === null);
        return {
            rows_total: mine.length,
            chained_rows: mine.length - pre.length,
            pre_chain_rows: pre.length,
            pre_chain_invalid: pre.filter(r => !r.hash || !HEX64.test(r.hash)).length,
            latest_captured_at: mine.reduce((m, r) => (!m || r.captured_at > m ? r.captured_at : m), null),
        };
    },
    async getAll(sql, params) {
        calls.getAll.push({ sql, params });
        if (dbError) throw dbError;
        return rows
            .filter(r => r.organization_id === params[0] && r.seq !== null)
            .sort((a, b) => b.seq - a.seq)
            .slice(0, params[1])
            .sort((a, b) => a.seq - b.seq)
            .map(r => ({ ...r, seq: String(r.seq) })); // int8 → string, as node-postgres does
    },
    async run() { return { rowCount: 0, rows: [] }; },
    async exec() {},
};

const dbPath = require.resolve(path.join(__dirname, '..', '..', '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { hashPayload, linkHash } = require('../../evidence/chain');
const check = require('./a5-28-evidence-integrity');

function chain(org, n, { capturedAt = new Date() } = {}) {
    const out = [];
    let prev = null;
    for (let seq = 1; seq <= n; seq++) {
        const payload = { status: 'pass', evidence: { n: seq }, details: null, run_type: 'scheduled', subject: null };
        const payload_hash = hashPayload(payload);
        const hash = linkHash(prev, payload_hash);
        out.push({ organization_id: org, seq, prev_hash: prev, payload_hash, hash, payload, captured_at: capturedAt });
        prev = hash;
    }
    return out;
}
function preChain(org, { hash, capturedAt = new Date() } = {}) {
    const payload = { legacy: true };
    return { organization_id: org, seq: null, prev_hash: null, payload_hash: null, hash: hash === undefined ? sha256(JSON.stringify(payload)) : hash, payload, captured_at: capturedAt };
}

test.beforeEach(() => { rows = []; dbError = null; calls.getOne.length = 0; calls.getAll.length = 0; });

test('registration metadata is unchanged by the rewrite', () => {
    assert.equal(check.id, 'ISO27001-A.5.28-evidence-integrity');
    assert.equal(check.regulation, 'ISO27001');
    assert.equal(check.article, 'A.5.28');
    assert.deepEqual(check.controls, ['A.5.28', 'A.5.36']);
    assert.equal(check.severity, 'medium');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.equal(check.titleKey, 'compliance.checks.iso_evidence_integrity.title');
    assert.equal(check.descriptionKey, 'compliance.checks.iso_evidence_integrity.desc');
    assert.equal(check.remediationKey, 'compliance.checks.iso_evidence_integrity.fix');
    assert.equal(check.remediationLink, null);
});

test('an intact chain passes and the details name the counts and the head', async () => {
    rows = [preChain('org'), preChain('org'), ...chain('org', 3)];
    const r = await check.evaluate('org');
    assert.equal(r.status, 'pass');
    assert.equal(r.details, 'Evidence chain intact: 3 linked row(s) verified (2 pre-chain row(s) fingerprinted), head #3.');
    // Evidence = the report.
    assert.equal(r.evidence.ok, true);
    assert.equal(r.evidence.verified_rows, 3);
    assert.equal(r.evidence.pre_chain_rows, 2);
    assert.deepEqual(r.evidence.head, { seq: 3, hash: rows[4].hash });
    assert.equal(r.evidence.first_break, null);
    assert.equal(r.evidence.window_rows, 5000);
});

test('the walk asks for the newest 5000 linked rows', async () => {
    rows = chain('org', 2);
    await check.evaluate('org');
    assert.equal(calls.getAll.length, 1);
    assert.equal(calls.getAll[0].params[1], 5000);
    assert.equal(calls.getAll[0].params[0], 'org');
});

test('a null orgId falls back to "default" like the other checks', async () => {
    rows = chain('default', 1);
    const r = await check.evaluate(null);
    assert.equal(r.status, 'pass');
    assert.equal(calls.getOne[0].params[0], 'default');
});

test('a broken link fails and the details name the row and the kind of break', async () => {
    rows = chain('org', 4);
    rows[2].hash = sha256('forged'); // seq 3
    const r = await check.evaluate('org');
    assert.equal(r.status, 'fail');
    assert.match(r.details, /^Evidence chain broken at row #3: a link that does not hash/);
    assert.match(r.details, /2 row\(s\) before it verify/);
    assert.deepEqual(r.evidence.first_break, { seq: 3, reason: 'link' });
});

test('a gap and an in-place payload edit fail with their own reason wording', async () => {
    rows = chain('org', 4).filter(r => r.seq !== 2);
    let r = await check.evaluate('org');
    assert.equal(r.status, 'fail');
    assert.match(r.details, /row #3: a gap in the sequence/);

    rows = chain('org', 4);
    rows[3].payload = { ...rows[3].payload, status: 'fail' };
    r = await check.evaluate('org');
    assert.equal(r.status, 'fail');
    assert.match(r.details, /row #4: a payload that no longer matches its stored fingerprint/);
    assert.deepEqual(r.evidence.first_break, { seq: 4, reason: 'content' });
});

test('chain columns not provisioned yet (42703) warns instead of failing or throwing', async () => {
    dbError = Object.assign(new Error('column "seq" does not exist'), { code: '42703', severity: 'ERROR' });
    const r = await check.evaluate('org');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned yet/);
    assert.equal(r.evidence.ok, null);
    assert.equal(r.evidence.reason, 'columns_missing');
});

test('an unreachable ledger warns with the fresh-install wording', async () => {
    dbError = Object.assign(new Error('relation "compliance_evidence" does not exist'), { code: '42P01', severity: 'ERROR' });
    const r = await check.evaluate('org');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not reachable yet/);
    assert.equal(r.evidence.ledger_reachable, false);
});

test('no evidence rows at all warns with the "no rows" wording', async () => {
    const r = await check.evaluate('org');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /^No evidence rows have been appended yet\./);
    assert.match(r.details, /first scheduled sweep seeds the chain/);
    assert.equal(r.evidence.rows_total, 0);
});

test('pre-chain rows only (chain not started) warns and points at the next sweep', async () => {
    rows = [preChain('org'), preChain('org'), preChain('org')];
    const r = await check.evaluate('org');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /has not started yet: 3 pre-chain row\(s\)/);
    assert.match(r.details, /first sweep after this release seeds the chain/);
    assert.equal(r.evidence.chained_rows, 0);
});

test('a malformed pre-chain fingerprint warns even when the chain itself is intact', async () => {
    rows = [preChain('org'), preChain('org', { hash: 'nope' }), preChain('org', { hash: null }), ...chain('org', 2)];
    const r = await check.evaluate('org');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /^Evidence chain intact \(2 linked row\(s\) verified\), but 2 of 3 pre-chain row\(s\)/);
    assert.equal(r.evidence.pre_chain_invalid, 2);
});

test('an intact but stale chain warns that the sweep stopped', async () => {
    rows = chain('org', 3, { capturedAt: new Date(Date.now() - 9 * DAY) });
    const r = await check.evaluate('org');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /newest row is 9 days old/);
    assert.equal(r.evidence.age_days, 9);
    assert.equal(r.evidence.fresh_days, 7);
});

test('a chain written within the week is fresh', async () => {
    rows = chain('org', 3, { capturedAt: new Date(Date.now() - 6 * DAY) });
    assert.equal((await check.evaluate('org')).status, 'pass');
});

test('a break outranks every warn condition', async () => {
    rows = [preChain('org', { hash: 'bad' }), ...chain('org', 3, { capturedAt: new Date(Date.now() - 30 * DAY) })];
    rows[2].payload_hash = sha256('x');
    const r = await check.evaluate('org');
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.first_break, { seq: 2, reason: 'link' });
});
