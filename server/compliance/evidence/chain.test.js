/**
 * verifyChain against an in-memory double of compliance_evidence that behaves
 * like node-postgres does: BIGINT `seq` comes back as a string, JSONB
 * `payload` comes back re-parsed (key order lost), COUNT(*)::int as a number.
 * Rows are built the way complianceStore.addEvidence chains them, then broken
 * one way at a time.
 *
 * Run: cd server && node --test --test-force-exit compliance/evidence/chain.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { hashPayload, linkHash, verifyChain } = require('./chain');
const { canonicalJSON } = require('./canonical');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

// ── in-memory compliance_evidence ────────────────────────────────────────────

/** Build a well-formed chain for `org` from a list of payloads (seq 1..n). */
function buildChain(org, payloads, { startSeq = 1, prevHash = null } = {}) {
    const rows = [];
    let prev = prevHash;
    let seq = startSeq;
    for (const payload of payloads) {
        const payload_hash = hashPayload(payload);
        const hash = linkHash(prev, payload_hash);
        rows.push({
            organization_id: org, seq, prev_hash: prev, payload_hash, hash,
            // JSONB: the document survives, the key order does not.
            payload: jsonbStore(payload),
            captured_at: new Date(Date.UTC(2026, 8, 1, 0, seq)),
        });
        prev = hash;
        seq++;
    }
    return rows;
}

// Re-parse and reverse the key order at the top level — a stand-in for
// Postgres printing the document back in its own key order.
function jsonbStore(payload) {
    const rt = JSON.parse(JSON.stringify(payload ?? {}));
    if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
        return Object.fromEntries(Object.keys(rt).reverse().map(k => [k, rt[k]]));
    }
    return rt;
}

/** Pre-chain row: hashed the old way (sha256 of JSON.stringify), no seq. */
function preChainRow(org, payload, { hash } = {}) {
    return {
        organization_id: org, seq: null, prev_hash: null, payload_hash: null,
        hash: hash === undefined ? sha256(JSON.stringify(payload)) : hash,
        payload: jsonbStore(payload),
        captured_at: new Date(Date.UTC(2026, 7, 1)),
    };
}

function fakeDb(rows, { columnsMissing = false, throwError = null } = {}) {
    const calls = { getOne: [], getAll: [] };
    const fail = () => {
        if (throwError) throw throwError;
        if (columnsMissing) {
            const e = new Error('column "seq" does not exist');
            e.code = '42703';
            e.severity = 'ERROR';
            throw e;
        }
    };
    return {
        calls,
        async getOne(sql, params) {
            calls.getOne.push({ sql, params });
            fail();
            assert.match(sql, /COUNT\(\*\)/);
            const mine = rows.filter(r => r.organization_id === params[0]);
            const pre = mine.filter(r => r.seq === null);
            const latest = mine.reduce((m, r) => (!m || r.captured_at > m ? r.captured_at : m), null);
            return {
                rows_total: mine.length,
                chained_rows: mine.length - pre.length,
                pre_chain_rows: pre.length,
                pre_chain_invalid: pre.filter(r => !r.hash || !HEX64.test(r.hash)).length,
                latest_captured_at: latest,
            };
        },
        async getAll(sql, params) {
            calls.getAll.push({ sql, params });
            fail();
            assert.match(sql, /seq IS NOT NULL/);
            assert.match(sql, /ORDER BY seq DESC\s+LIMIT \$2/);
            const limit = params[1];
            return rows
                .filter(r => r.organization_id === params[0] && r.seq !== null)
                .sort((a, b) => b.seq - a.seq)
                .slice(0, limit)
                .sort((a, b) => a.seq - b.seq)
                // node-postgres: int8 → string; JSONB → object (fresh copy).
                .map(r => ({
                    seq: String(r.seq), hash: r.hash, prev_hash: r.prev_hash,
                    payload_hash: r.payload_hash, payload: JSON.parse(JSON.stringify(r.payload)),
                }));
        },
    };
}

const P = [
    { status: 'pass', evidence: { count: 3.0 }, details: 'ok', run_type: 'scheduled', subject: null },
    { status: 'warn', evidence: { missing: ['a', 'b'] }, details: 'two missing', run_type: 'manual', subject: { id: 's1', label: 'S' } },
    { status: 'fail', evidence: { at: new Date('2026-09-14T09:12:00Z') }, details: null, run_type: 'scheduled', subject: null },
];

// ── hash primitives ──────────────────────────────────────────────────────────

test('linkHash is sha256((prev_hash || "") + payload_hash); genesis hashes the payload_hash alone', () => {
    const ph = hashPayload({ a: 1 });
    assert.equal(linkHash(null, ph), sha256(ph));
    assert.equal(linkHash(undefined, ph), sha256(ph));
    assert.equal(linkHash('', ph), sha256(ph));
    assert.equal(linkHash('abc', ph), sha256('abc' + ph));
    assert.match(linkHash('abc', ph), HEX64);
});

test('hashPayload is the canonical-JSON sha256 re-exported from canonical.js', () => {
    assert.equal(hashPayload({ b: 1, a: 2 }), sha256(canonicalJSON({ a: 2, b: 1 })));
});

// ── verification ─────────────────────────────────────────────────────────────

test('genesis: a single row with prev_hash NULL verifies and is the head', async () => {
    const rows = buildChain('org', [P[0]]);
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.equal(r.ok, true);
    assert.equal(r.rows_total, 1);
    assert.equal(r.chained_rows, 1);
    assert.equal(r.verified_rows, 1);
    assert.equal(r.pre_chain_rows, 0);
    assert.equal(r.pre_chain_invalid, 0);
    assert.equal(r.first_break, null);
    assert.deepEqual(r.head, { seq: 1, hash: rows[0].hash });
    assert.deepEqual(r.window, { limit: 2000, from_seq: 1, to_seq: 1 });
    assert.equal(typeof r.checked_at, 'string');
    assert.equal(r.reason, undefined);
});

test('a genesis row that claims a predecessor is a broken link', async () => {
    const rows = buildChain('org', [P[0]], { prevHash: sha256('ghost') });
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.first_break, { seq: 1, reason: 'link' });
    assert.equal(r.verified_rows, 0);
});

test('a valid 3-row chain verifies end to end, through the JSONB key reorder', async () => {
    const rows = buildChain('org', P);
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.equal(r.ok, true);
    assert.equal(r.chained_rows, 3);
    assert.equal(r.verified_rows, 3);
    assert.equal(r.first_break, null);
    assert.deepEqual(r.head, { seq: 3, hash: rows[2].hash });
    assert.equal(r.latest_captured_at, rows[2].captured_at);
    assert.match(r.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'checked_at is an ISO timestamp');
});

test('a missing seq is a gap at the first row after the hole; rows before it stay verified', async () => {
    const rows = buildChain('org', [...P, P[0]]);
    // seq 3 is deleted → 1, 2, 4 remain; 4 still links to 3's hash.
    const withHole = rows.filter(r => r.seq !== 3);
    const r = await verifyChain('org', { db: fakeDb(withHole) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.first_break, { seq: 4, reason: 'gap' });
    assert.equal(r.verified_rows, 2);
    assert.equal(r.chained_rows, 3);
    assert.deepEqual(r.head, { seq: 4, hash: rows[3].hash }, 'head still reports the newest row');
});

test('a rewritten hash is a broken link at that row', async () => {
    const rows = buildChain('org', P);
    rows[1].hash = sha256('forged');
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.first_break, { seq: 2, reason: 'link' });
    assert.equal(r.verified_rows, 1);
});

test('a row re-hashed consistently but no longer pointing at its predecessor is a broken link', async () => {
    const rows = buildChain('org', P);
    // Attacker rewrites row 3 in full (prev_hash + hash self-consistent) — the
    // dangling prev_hash still gives it away.
    rows[2].prev_hash = sha256('elsewhere');
    rows[2].hash = linkHash(rows[2].prev_hash, rows[2].payload_hash);
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.deepEqual(r.first_break, { seq: 3, reason: 'link' });
    assert.equal(r.verified_rows, 2);
});

test('a missing or malformed payload_hash on a chained row is a broken link', async () => {
    const rows = buildChain('org', P);
    rows[2].payload_hash = null;
    assert.deepEqual((await verifyChain('org', { db: fakeDb(rows) })).first_break, { seq: 3, reason: 'link' });
    rows[2].payload_hash = 'not-hex';
    assert.deepEqual((await verifyChain('org', { db: fakeDb(rows) })).first_break, { seq: 3, reason: 'link' });
});

test('a payload altered in place with the hashes left intact is a content break, not a link break', async () => {
    const rows = buildChain('org', P);
    rows[1].payload = { ...rows[1].payload, status: 'pass' }; // was 'warn'
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.first_break, { seq: 2, reason: 'content' });
    assert.equal(r.verified_rows, 1);
    // The link over the (unchanged) payload_hash still holds — that is what
    // distinguishes 'content' from 'link'.
    assert.equal(rows[1].hash, linkHash(rows[0].hash, rows[1].payload_hash));
});

test('a payload handed back as JSON text hashes like the parsed object', async () => {
    const rows = buildChain('org', P);
    const db = fakeDb(rows);
    const inner = db.getAll.bind(db);
    db.getAll = async (sql, params) => (await inner(sql, params)).map(r => ({ ...r, payload: JSON.stringify(r.payload) }));
    const r = await verifyChain('org', { db });
    assert.equal(r.ok, true);
    assert.equal(r.verified_rows, 3);
});

test('pre-chain rows are counted and shape-checked, never walked', async () => {
    const rows = [
        preChainRow('org', { legacy: 1 }),
        preChainRow('org', { legacy: 2 }, { hash: null }),
        preChainRow('org', { legacy: 3 }, { hash: 'DEADBEEF' }),
        ...buildChain('org', P),
    ];
    const r = await verifyChain('org', { db: fakeDb(rows) });
    assert.equal(r.ok, true, 'pre-chain shape failures do not break the chain');
    assert.equal(r.rows_total, 6);
    assert.equal(r.pre_chain_rows, 3);
    assert.equal(r.pre_chain_invalid, 2);
    assert.equal(r.chained_rows, 3);
    assert.equal(r.verified_rows, 3);
    assert.deepEqual(r.head, { seq: 3, hash: rows[5].hash });
});

test('an org with no rows: ok, empty, no head', async () => {
    const r = await verifyChain('empty', { db: fakeDb(buildChain('other', P)) });
    assert.equal(r.ok, true);
    assert.equal(r.rows_total, 0);
    assert.equal(r.chained_rows, 0);
    assert.equal(r.pre_chain_rows, 0);
    assert.equal(r.verified_rows, 0);
    assert.equal(r.head, null);
    assert.equal(r.window, null);
    assert.equal(r.first_break, null);
});

test('the walk is scoped to the org', async () => {
    const rows = [...buildChain('a', P), ...buildChain('b', [P[0]])];
    rows[1].hash = 'x'.repeat(64); // break org a only
    assert.equal((await verifyChain('a', { db: fakeDb(rows) })).ok, false);
    const b = await verifyChain('b', { db: fakeDb(rows) });
    assert.equal(b.ok, true);
    assert.equal(b.rows_total, 1);
});

test('missing chain columns (42703) degrade to ok:null / columns_missing instead of throwing', async () => {
    const r = await verifyChain('org', { db: fakeDb([], { columnsMissing: true }) });
    assert.equal(r.ok, null);
    assert.equal(r.reason, 'columns_missing');
    assert.equal(r.chained_rows, 0);
    assert.equal(r.verified_rows, 0);
    assert.equal(r.first_break, null);
    assert.equal(r.head, null);
    assert.equal(r.rows_total, null);
    assert.equal(typeof r.checked_at, 'string');
});

test('other database errors propagate to the caller', async () => {
    const boom = Object.assign(new Error('relation "compliance_evidence" does not exist'), { code: '42P01', severity: 'ERROR' });
    await assert.rejects(verifyChain('org', { db: fakeDb([], { throwError: boom }) }), /does not exist/);
});

test('limit: only the newest `limit` chained rows are loaded; the window start is not gap-checked', async () => {
    const rows = buildChain('org', Array.from({ length: 10 }, (_, i) => ({ i })));
    const db = fakeDb(rows);
    const r = await verifyChain('org', { limit: 3, db });
    assert.equal(db.calls.getAll.length, 1);
    assert.equal(db.calls.getAll[0].params[1], 3, 'LIMIT is passed to SQL — never loads more than `limit`');
    assert.equal(r.ok, true);
    assert.equal(r.chained_rows, 10, 'org-wide count is not capped by the window');
    assert.equal(r.verified_rows, 3);
    assert.deepEqual(r.window, { limit: 3, from_seq: 8, to_seq: 10 });
    assert.deepEqual(r.head, { seq: 10, hash: rows[9].hash });
});

test('limit: a break older than the window is not seen (documented window semantics)', async () => {
    const rows = buildChain('org', Array.from({ length: 6 }, (_, i) => ({ i })));
    rows[1].payload = { i: 99 }; // content break at seq 2
    assert.deepEqual((await verifyChain('org', { limit: 3, db: fakeDb(rows) })).first_break, null);
    assert.deepEqual((await verifyChain('org', { limit: 6, db: fakeDb(rows) })).first_break, { seq: 2, reason: 'content' });
});

test('limit is coerced: garbage falls back to 2000, non-positive to 1', async () => {
    const rows = buildChain('org', P);
    let db = fakeDb(rows);
    await verifyChain('org', { limit: 'lots', db });
    assert.equal(db.calls.getAll[0].params[1], 2000);
    db = fakeDb(rows);
    const r = await verifyChain('org', { limit: 0, db });
    assert.equal(db.calls.getAll[0].params[1], 1);
    assert.equal(r.verified_rows, 1);
});
