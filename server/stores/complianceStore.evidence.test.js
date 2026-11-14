/**
 * complianceStore — the evidence chain write path, score snapshots and check
 * rows after the Compliance Center redesign, against a real Postgres (PGlite
 * behind db.js's pool, testUtils/pglitePool.js, with the store's own schema).
 *
 * What matters in THIS file is that addEvidence (1) chains per org, (2)
 * numbers the row head+1 with prev_hash = head.hash, (3) folds a
 * caller-supplied digest into the payload instead of the link column, and (4)
 * returns {id, seq, hash}. The expected hashes come from the real chain
 * primitives (compliance/evidence/chain.js).
 *
 * Run: cd server && node --test stores/complianceStore.evidence.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { hashPayload, linkHash } = require('../compliance/evidence/chain');

const { pg, close } = usePglitePool();
const store = require('./complianceStore');

before(async () => { await store.initDB(); });
after(close);
beforeEach(() => pg.exec('DELETE FROM compliance_evidence; DELETE FROM compliance_score_history; DELETE FROM compliance_checks'));

const evidenceRows = async () => (await pg.query('SELECT * FROM compliance_evidence ORDER BY id')).rows;

// ── addEvidence ──────────────────────────────────────────────────────────

test('genesis link: seq 1, prev_hash NULL, hash = linkHash(null, payload_hash), returns {id, seq, hash}', async () => {
    const out = await store.addEvidence({
        organization_id: 'orgA', check_id: 'GDPR-Art30-ropa', subject_type: 'ropa', subject_id: null,
        payload: { action: 'x' },
    });
    const payloadHash = hashPayload({ action: 'x' });
    const [row] = await evidenceRows();
    assert.deepStrictEqual(out, { id: row.id, seq: 1, hash: linkHash(null, payloadHash) });
    assert.strictEqual(row.organization_id, 'orgA', 'org-scoped');
    assert.strictEqual(row.payload_hash, payloadHash);
    assert.strictEqual(row.prev_hash, null);
    assert.strictEqual(row.seq, 1);
    assert.strictEqual(row.hash, out.hash);
    assert.deepStrictEqual(row.payload, { action: 'x' });
});

test('the second link reads the head and chains onto it (seq +1, prev_hash = head.hash)', async () => {
    const first = await store.addEvidence({ organization_id: 'orgA', payload: { n: 1 } });
    const second = await store.addEvidence({ organization_id: 'orgA', payload: { n: 2 } });
    assert.strictEqual(second.seq, 2);
    assert.strictEqual(second.hash, linkHash(first.hash, hashPayload({ n: 2 })));
    // A different org starts its own chain at 1.
    const other = await store.addEvidence({ organization_id: 'orgB', payload: { n: 1 } });
    assert.strictEqual(other.seq, 1);
    // An unchained row of no org does not become anyone's head.
    await store.addEvidence({ payload: { n: 9 } });
    const third = await store.addEvidence({ organization_id: 'orgA', payload: { n: 3 } });
    assert.strictEqual(third.seq, 3);
    const rows = await evidenceRows();
    assert.strictEqual(rows[1].prev_hash, first.hash);
    assert.strictEqual(rows[2].prev_hash, null);
    assert.strictEqual(rows.at(-1).prev_hash, second.hash);
});

test('a caller-supplied hash is folded into payload.sha256 when absent, and never wins over an existing one', async () => {
    await store.addEvidence({
        organization_id: 'orgA', check_id: 'ISO27001-A.5.28', subject_type: 'file', subject_id: 'f1',
        hash: 'filesha', storage_key: 'iso-evidence/orgA/x', payload: { action: 'evidence_file_uploaded', filename: 'a.pdf' },
    });
    await store.addEvidence({ organization_id: 'orgA', hash: 'ignored', payload: { sha256: 'explicit' } });
    const [first, second] = await evidenceRows();
    assert.strictEqual(first.payload.sha256, 'filesha', 'digest lives in the payload');
    assert.strictEqual(first.payload_hash, hashPayload({ action: 'evidence_file_uploaded', filename: 'a.pdf', sha256: 'filesha' }));
    assert.notStrictEqual(first.hash, 'filesha', 'the hash column is the link hash, not the file digest');
    assert.strictEqual(first.storage_key, 'iso-evidence/orgA/x');
    assert.strictEqual(second.payload.sha256, 'explicit');
});

test('the nine pre-chain call-site shapes still work: hash + payload, no seq/prev_hash from the caller', async () => {
    // runner.js shape
    const r = await store.addEvidence({ organization_id: 'o', check_id: 'GDPR-Art5-x', subject_type: 'global', subject_id: null, hash: 'h1', payload: { status: 'pass' } });
    // incidents / soa / overview: subject ids as numbers
    const s = await store.addEvidence({ organization_id: 'o', check_id: null, subject_type: 'incident', subject_id: 12, hash: 'h2', payload: { action: 'incident_created' } });
    assert.strictEqual(r.seq, 1);
    assert.strictEqual(s.seq, 2);
    assert.strictEqual(String((await evidenceRows())[1].subject_id), '12');
});

test('a row without an organization is stored unchained (seq NULL)', async () => {
    const out = await store.addEvidence({ check_id: 'X', payload: { a: 1 } });
    assert.strictEqual(out.seq, null);
    assert.strictEqual(out.hash, linkHash(null, hashPayload({ a: 1 })));
    const [row] = await evidenceRows();
    assert.strictEqual(row.organization_id, null);
    assert.strictEqual(row.seq, null);
});

/**
 * Every statement db.js sends while `fn` runs, and where it went: `client` (a
 * connection withTransaction checked out) or `pool`. One PGlite session cannot
 * run two writers at once, so the per-org serialisation is pinned as statements.
 * @param {() => Promise<unknown>} fn
 */
async function recordStatements(fn) {
    const db = require('../db');
    const saved = { query: db.pool.query, connect: db.pool.connect };
    /** @type {{ via: string, sql: string, params: unknown }[]} */
    const sent = [];
    const tap = (/** @type {string} */ via, /** @type {Function} */ q) => (/** @type {any} */ sql, /** @type {unknown} */ params) => {
        sent.push({ via, sql: String(sql?.text ?? sql).replace(/\s+/g, ' ').trim(), params });
        return q(sql, params);
    };
    db.pool.query = /** @type {any} */ (tap('pool', saved.query));
    db.pool.connect = /** @type {any} */ (async () => {
        const c = await saved.connect();
        return { ...c, query: tap('client', c.query) };
    });
    try { await fn(); } finally { Object.assign(db.pool, saved); }
    return sent;
}

test('addEvidence serialises per org: BEGIN, advisory lock on the org, head SELECT, INSERT, COMMIT on one connection', async () => {
    await store.addEvidence({ organization_id: 'orgA', payload: { n: 1 } });
    const sent = await recordStatements(() => store.addEvidence({ organization_id: 'orgA', payload: { n: 2 } }));
    const at = (/** @type {(sql: string) => boolean} */ match) => sent.findIndex(s => match(s.sql));
    const begin = at(s => s === 'BEGIN');
    const lock = at(s => s.includes("pg_advisory_xact_lock(hashtext('beeflow:evidence:' || $1))"));
    const head = at(s => s.startsWith('SELECT seq, hash FROM compliance_evidence'));
    const insert = at(s => s.startsWith('INSERT INTO compliance_evidence'));
    const commit = at(s => s === 'COMMIT');
    assert.ok(begin >= 0 && lock > begin && head > lock && insert > head && commit > insert,
        `order: ${JSON.stringify(sent.map(s => s.sql.slice(0, 60)))}`);
    for (const i of [begin, lock, head, insert, commit]) assert.strictEqual(sent[i].via, 'client', `on the transaction's connection: ${sent[i].sql.slice(0, 60)}`);
    assert.deepStrictEqual(sent[lock].params, ['orgA'], 'the lock key is the org');
});

test('a row without an organization takes no advisory lock', async () => {
    const sent = await recordStatements(() => store.addEvidence({ check_id: 'X', payload: { a: 1 } }));
    assert.ok(sent.some(s => s.sql.startsWith('INSERT INTO compliance_evidence')), 'the row was written');
    assert.ok(!sent.some(s => s.sql.includes('pg_advisory_xact_lock')), `no lock: ${JSON.stringify(sent.map(s => s.sql.slice(0, 60)))}`);
});

test('getChainHead returns {seq, hash} of the newest chained link, or null', async () => {
    assert.strictEqual(await store.getChainHead('orgA'), null);
    await store.addEvidence({ organization_id: 'orgA', payload: { n: 1 } });
    const two = await store.addEvidence({ organization_id: 'orgA', payload: { n: 2 } });
    await store.addEvidence({ organization_id: 'orgB', payload: { n: 1 } });
    assert.deepStrictEqual(await store.getChainHead('orgA'), { seq: 2, hash: two.hash });
    assert.strictEqual(await store.getChainHead('orgZ'), null, 'org-scoped');
});

// ── reads ────────────────────────────────────────────────────────────────

test('evidence reads carry the chain columns and stay org-scoped', async () => {
    const mine = await store.addEvidence({ organization_id: 'orgA', check_id: 'GDPR-Art30-ropa', payload: { n: 1 } });
    const theirs = await store.addEvidence({ organization_id: 'orgB', check_id: 'GDPR-Art30-ropa', payload: { n: 1 } });

    const byId = await store.getEvidenceById('orgA', String(mine.id));
    assert.strictEqual(byId.id, mine.id, 'id coerced to a number');
    for (const col of ['seq', 'prev_hash', 'payload_hash']) assert.ok(col in byId, `${col} selected`);
    assert.ok(!(await store.getEvidenceById('orgA', String(theirs.id))), 'another org\'s row is not readable by id');

    assert.deepStrictEqual((await store.getEvidenceHistory('orgA', 'GDPR-Art30-ropa', 5)).map(r => r.id), [mine.id]);
    const list = await store.listEvidence('orgA', { limit: 10 });
    assert.deepStrictEqual(list.map(r => r.id), [mine.id]);
    assert.ok('payload_hash' in list[0]);
});

test('listEvidence filters by regulation via the check-id prefix, clamps limit/offset; countEvidence shares the WHERE', async () => {
    const dataAct = await store.addEvidence({ organization_id: 'orgA', check_id: 'DATA_ACT-Art25', payload: {} });
    await store.addEvidence({ organization_id: 'orgA', check_id: 'DATAXACT-Art25', payload: {} });  // `_` must not be a wildcard
    await store.addEvidence({ organization_id: 'orgB', check_id: 'DATA_ACT-Art25', payload: {} });
    const soa = await store.addEvidence({ organization_id: 'orgA', check_id: 'X', subject_type: 'soa', subject_id: 9, payload: {} });
    await store.addEvidence({ organization_id: 'orgA', check_id: 'X', subject_type: 'soa', subject_id: 10, payload: {} });

    assert.deepStrictEqual((await store.listEvidence('orgA', { regulation: 'DATA_ACT', limit: 5000, offset: -3 })).map(r => r.id), [dataAct.id],
        'the underscore is escaped so DATA_ACT does not match DATAXACT; limit and offset are clamped, not refused');
    assert.deepStrictEqual((await store.listEvidence('orgA', { checkId: 'X', subjectType: 'soa', subjectId: '9' })).map(r => r.id), [soa.id]);
    assert.strictEqual(await store.countEvidence('orgA'), 4);
    assert.strictEqual(await store.countEvidence('orgA', { regulation: 'DATA_ACT' }), 1);

    const page = await store.listEvidence('orgA', { limit: 2, offset: 1 });
    assert.strictEqual(page.length, 2);
    const all = await store.listEvidence('orgA');
    assert.deepStrictEqual(all.map(r => r.id), [...all.map(r => r.id)].sort((a, b) => b - a), 'newest first');
    assert.deepStrictEqual(page.map(r => r.id), all.slice(1, 3).map(r => r.id));
});

// ── score history ────────────────────────────────────────────────────────

const scoreRows = async () => (await pg.query('SELECT * FROM compliance_score_history ORDER BY id')).rows;

test('recordScoreSnapshot writes scores JSONB next to the legacy three, filling whichever side is missing', async () => {
    await store.recordScoreSnapshot({
        organization_id: 'orgA', overall_score: 70, gdpr_score: 80, aia_score: 60, iso_score: 90,
        pass: 10, warn: 2, fail: 1, na: 3, run_type: 'scheduled',
        scores: { gdpr: 80, aia: 60, iso27001: 90, nis2: 40, 'custom:abc': null },
    });
    // only `scores` given → legacy columns derived
    await store.recordScoreSnapshot({ organization_id: 'orgA', scores: { gdpr: 71, aia: 52, iso27001: 93 } });
    // only legacy given (old runner) → scores populated from them
    await store.recordScoreSnapshot({ organization_id: 'orgA', gdpr_score: 1, aia_score: 2, iso_score: 3 });

    const [full, scoresOnly, legacyOnly] = await scoreRows();
    assert.deepStrictEqual([full.gdpr_score, full.aia_score, full.iso_score], [80, 60, 90]);
    assert.deepStrictEqual(full.scores, { gdpr: 80, aia: 60, iso27001: 90, nis2: 40, 'custom:abc': null });
    assert.strictEqual(full.coverage, null, 'a snapshot that recorded no coverage stores NULL, never an empty "all covered"');
    assert.deepStrictEqual([scoresOnly.gdpr_score, scoresOnly.aia_score, scoresOnly.iso_score], [71, 52, 93]);
    assert.deepStrictEqual(legacyOnly.scores, { gdpr: 1, aia: 2, iso27001: 3 });
    assert.strictEqual(legacyOnly.organization_id, 'orgA');
});

test('getScoreHistory returns scores, synthesising {gdpr, aia, iso27001} for rows with an empty JSONB — no UPDATE', async () => {
    const at = (d) => new Date(Date.now() - d * 86400_000).toISOString();
    await pg.query(`INSERT INTO compliance_score_history (organization_id, gdpr_score, aia_score, iso_score, scores, captured_at) VALUES
        ('orgA', 80, NULL, 90, '{}'::jsonb, $1),
        ('orgA', 81, 61, 91, NULL, $2),
        ('orgA', 82, 62, 92, '{"gdpr":82,"aia":62,"iso27001":92,"nis2":40}'::jsonb, $3),
        ('orgB', 1, 1, 1, '{}'::jsonb, $3),
        ('orgA', 50, 50, 50, '{}'::jsonb, $4)`, [at(3), at(2), at(1), at(60)]);
    const rows = await store.getScoreHistory('orgA', 30);
    assert.strictEqual(rows.length, 3, 'org-scoped, and within the window');
    assert.deepStrictEqual(rows[0].scores, { gdpr: 80, aia: null, iso27001: 90 });
    assert.deepStrictEqual(rows[1].scores, { gdpr: 81, aia: 61, iso27001: 91 });
    assert.deepStrictEqual(rows[2].scores, { gdpr: 82, aia: 62, iso27001: 92, nis2: 40 }, 'stored JSONB wins');
    assert.strictEqual(rows[0].gdpr_score, 80, 'legacy columns still on the row');
    assert.deepStrictEqual((await scoreRows()).map(r => r.scores)[1], null, 'read path never writes');
    assert.strictEqual((await store.getScoreHistory('orgA', 90)).length, 4);
});

// ── score history: coverage ──────────────────────────────────────────────
//
// The score and what it was computed over live on the SAME row on purpose.
// Before this column the Compliance Center's trend line was a series of bare
// numbers, and an organisation whose tables had never been recorded anywhere
// got the score of the checks that happened to run — a line that climbed as
// coverage fell. See compliance/runner.js, COVERAGE.

test('recordScoreSnapshot stores the coverage summary beside the number it qualifies', async () => {
    const coverage = {
        total: 11, examined: 3, unexamined: 8, unknown_populations: 0, complete: false,
        populations: [{ check_id: 'GDPR-Art30-datatable-registrations', kind: 'datatable', total: 11, examined: 3, unexamined: 8 }],
    };
    await store.recordScoreSnapshot({ organization_id: 'orgA', overall_score: 100, scores: { gdpr: 100 }, coverage });
    assert.deepStrictEqual((await scoreRows())[0].coverage, coverage);
    assert.deepStrictEqual((await store.getScoreHistory('orgA', 30))[0].coverage, coverage);
});

test('getScoreHistory never invents coverage for a row that has none', async () => {
    const at = (d) => new Date(Date.now() - d * 86400_000).toISOString();
    await pg.query(`INSERT INTO compliance_score_history (organization_id, gdpr_score, scores, coverage, captured_at) VALUES
        ('orgA', 100, '{}'::jsonb, NULL, $1),
        ('orgA', 100, '{}'::jsonb, '{"total":11,"examined":3,"unexamined":8,"complete":false}'::jsonb, $2)`, [at(2), at(1)]);
    const rows = await store.getScoreHistory('orgA', 30);
    assert.strictEqual(rows[0].coverage, null, 'an old row is "coverage not recorded", never "everything covered"');
    assert.strictEqual(rows[1].coverage.unexamined, 8);
    assert.strictEqual(rows[1].coverage.complete, false);
    assert.strictEqual((await scoreRows())[0].coverage, null, 'read path never writes');
});

// ── check results ────────────────────────────────────────────────────────

test('recordCheckResult passes framework_code through (null when absent); getLatestPerCheck/getCheckHistory return it, org-scoped', async () => {
    await store.recordCheckResult({ organization_id: 'orgA', check_id: 'CUSTOM-ISAE-1', regulation: 'CUSTOM', status: 'pass', framework_code: 'ISAE' });
    await store.recordCheckResult({ organization_id: 'orgA', check_id: 'GDPR-Art30-ropa', regulation: 'GDPR', status: 'warn' });
    await store.recordCheckResult({ organization_id: 'orgB', check_id: 'GDPR-Art30-ropa', regulation: 'GDPR', status: 'fail' });

    const latest = await store.getLatestPerCheck('orgA');
    const byCheck = Object.fromEntries(latest.map(r => [r.check_id, r]));
    assert.deepStrictEqual(Object.keys(byCheck).sort(), ['CUSTOM-ISAE-1', 'GDPR-Art30-ropa']);
    assert.strictEqual(byCheck['CUSTOM-ISAE-1'].framework_code, 'ISAE');
    assert.strictEqual(byCheck['GDPR-Art30-ropa'].framework_code, null);
    assert.strictEqual(byCheck['GDPR-Art30-ropa'].status, 'warn', 'not orgB\'s row');
    const history = await store.getCheckHistory('orgA', 'GDPR-Art30-ropa', 10);
    assert.deepStrictEqual(history.map(r => r.status), ['warn']);
    assert.ok('framework_code' in history[0]);
});

test('getCheckHistory narrows to one subject slot when a scope is given, and reads every slot without one', async () => {
    const check = 'GDPR-Art35-dpia-high-risk';
    await store.recordCheckResult({ organization_id: 'orgA', check_id: check, regulation: 'GDPR', status: 'warn', scope_type: 'agent', scope_id: 'agent_claims' });
    await store.recordCheckResult({ organization_id: 'orgA', check_id: check, regulation: 'GDPR', status: 'pass', scope_type: 'agent', scope_id: 'agent_other' });
    await store.recordCheckResult({ organization_id: 'orgA', check_id: check, regulation: 'GDPR', status: 'fail' });
    const statuses = async (opts) => (await store.getCheckHistory('orgA', check, 100, opts)).map(r => r.status).sort();
    assert.deepStrictEqual(await statuses({ scopeId: 'agent_claims' }), ['warn']);
    assert.deepStrictEqual(await statuses(undefined), ['fail', 'pass', 'warn']);
    assert.deepStrictEqual(await statuses({ scopeId: '' }), ['fail', 'pass', 'warn'], 'an empty scope is no filter');
});
