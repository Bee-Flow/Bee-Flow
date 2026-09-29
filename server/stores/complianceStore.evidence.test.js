/**
 * complianceStore — the evidence chain write path, score snapshots and check
 * rows after the Compliance Center redesign.
 *
 * The chain primitives (compliance/evidence/chain.js: hashPayload, linkHash)
 * belong to another workstream and are stubbed here with a tiny deterministic
 * "hash" so the assertions read as arithmetic: what matters in THIS file is
 * that addEvidence (1) locks per org, (2) reads the head inside the same
 * transaction, (3) numbers the row head+1 with prev_hash = head.hash, (4) folds
 * a caller-supplied digest into the payload instead of the link column, and
 * (5) returns {id, seq, hash}.
 *
 * Run: cd server && node --test --test-force-exit stores/complianceStore.evidence.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── chain stub: visible arithmetic instead of sha256 ─────────────────────
const chainStub = {
    hashPayload: (payload) => `P(${JSON.stringify(payload)})`,
    linkHash: (prev, payloadHash) => `L(${prev === null ? '∅' : prev}|${payloadHash})`,
};

// ── recording db ─────────────────────────────────────────────────────────
const evidenceRows = [];
const scoreRows = [];
const checkRows = [];
let nextId = 1;

const mock = createRecordingDb({
    tables: { compliance_evidence: evidenceRows, compliance_score_history: scoreRows, compliance_checks: checkRows },
    matchers: {
        // Head lookup: the equality matcher cannot see `seq IS NOT NULL` or
        // ORDER BY … LIMIT 1, so model it here; everything else falls back.
        compliance_evidence(rows, sql, params) {
            if (/ORDER BY seq DESC/i.test(sql)) {
                return rows
                    .filter(r => r.organization_id === params[0] && r.seq != null)
                    .sort((a, b) => b.seq - a.seq)
                    .slice(0, 1);
            }
            return undefined;
        },
    },
    onQuery(sql, params) {
        if (/^INSERT INTO compliance_evidence/i.test(sql)) {
            const cols = sql.match(/\(([\s\S]*?)\)\s*VALUES/i)[1].split(',').map(s => s.trim());
            const vals = sql.match(/VALUES\s*\(([\s\S]*?)\)/i)[1].split(',').map(s => s.trim());
            const row = { id: nextId++, seq: null, prev_hash: null };
            cols.forEach((c, i) => {
                const p = vals[i].match(/^\$(\d+)/);
                row[c] = p ? params[Number(p[1]) - 1] : (vals[i] === 'NULL' ? null : vals[i]);
            });
            evidenceRows.push(row);
            return { rows: [{ id: row.id, seq: row.seq, hash: row.hash }], rowCount: 1 };
        }
        if (/^SELECT COUNT\(\*\)::int AS n FROM compliance_evidence/i.test(sql)) {
            return { rows: [{ n: evidenceRows.filter(r => r.organization_id === params[0]).length }], rowCount: 1 };
        }
        return undefined;
    },
});

const restore = installResolveStub({
    '../db': mock.db,
    '../compliance/evidence/chain': chainStub,
});
const store = require('./complianceStore');

before(async () => { await store.initDB(); });
after(() => restore());
beforeEach(() => {
    evidenceRows.length = 0;
    scoreRows.length = 0;
    checkRows.length = 0;
    nextId = 1;
    mock.reset();
});

const insertsOf = (table) => mock.mutations().filter(m => new RegExp(`^INSERT INTO ${table}`, 'i').test(m.sql.trim()));
const clientSql = () => mock.calls.client.map(c => c.sql.trim().replace(/\s+/g, ' '));

// ── addEvidence ──────────────────────────────────────────────────────────

test('genesis link: seq 1, prev_hash NULL, hash = linkHash(null, payload_hash), returns {id, seq, hash}', async () => {
    const out = await store.addEvidence({
        organization_id: 'orgA', check_id: 'GDPR-Art30-ropa', subject_type: 'ropa', subject_id: null,
        payload: { action: 'x' },
    });
    const payloadHash = chainStub.hashPayload({ action: 'x' });
    assert.deepStrictEqual(out, { id: 1, seq: 1, hash: chainStub.linkHash(null, payloadHash) });
    const [ins] = insertsOf('compliance_evidence');
    assert.ok(ins, 'one INSERT');
    assert.strictEqual(ins.params[0], 'orgA', 'org-scoped');
    assert.strictEqual(evidenceRows[0].payload_hash, payloadHash);
    assert.strictEqual(evidenceRows[0].prev_hash, null);
    assert.strictEqual(evidenceRows[0].seq, 1);
    assert.match(ins.sql, /RETURNING id, seq, hash/);
});

test('the second link reads the head and chains onto it (seq +1, prev_hash = head.hash)', async () => {
    const first = await store.addEvidence({ organization_id: 'orgA', payload: { n: 1 } });
    const second = await store.addEvidence({ organization_id: 'orgA', payload: { n: 2 } });
    assert.strictEqual(second.seq, 2);
    assert.strictEqual(evidenceRows[1].prev_hash, first.hash);
    assert.strictEqual(second.hash, chainStub.linkHash(first.hash, chainStub.hashPayload({ n: 2 })));
    // A different org starts its own chain at 1.
    const other = await store.addEvidence({ organization_id: 'orgB', payload: { n: 1 } });
    assert.strictEqual(other.seq, 1);
    assert.strictEqual(evidenceRows[2].prev_hash, null);
});

test('addEvidence runs in a transaction: BEGIN → per-org advisory lock → head SELECT → INSERT → COMMIT', async () => {
    await store.addEvidence({ organization_id: 'orgA', payload: {} });
    const seq = clientSql();
    const i = (re) => seq.findIndex(s => re.test(s));
    const begin = i(/^BEGIN$/), lock = i(/pg_advisory_xact_lock\(hashtext\('beeflow:evidence:' \|\| \$1\)\)/), head = i(/SELECT seq, hash FROM compliance_evidence/), ins = i(/^INSERT INTO compliance_evidence/), commit = i(/^COMMIT$/);
    assert.ok(begin >= 0 && lock > begin && head > lock && ins > head && commit > ins, `order: ${JSON.stringify(seq)}`);
    const lockCall = mock.calls.client.find(c => /pg_advisory_xact_lock/.test(c.sql));
    assert.deepStrictEqual(lockCall.params, ['orgA'], 'the lock key is the org');
    const headCall = mock.calls.client.find(c => /SELECT seq, hash FROM compliance_evidence/.test(c.sql));
    assert.match(headCall.sql, /organization_id = \$1 AND seq IS NOT NULL/);
    assert.deepStrictEqual(headCall.params, ['orgA']);
    assert.ok(!mock.calls.run.some(c => /INSERT INTO compliance_evidence/.test(c.sql)), 'the INSERT goes through the transaction client, not the pool');
});

test('a caller-supplied hash is folded into payload.sha256 when absent, and never wins over an existing one', async () => {
    await store.addEvidence({
        organization_id: 'orgA', check_id: 'ISO27001-A.5.28', subject_type: 'file', subject_id: 'f1',
        hash: 'filesha', storage_key: 'iso-evidence/orgA/x', payload: { action: 'evidence_file_uploaded', filename: 'a.pdf' },
    });
    const stored = JSON.parse(evidenceRows[0].payload);
    assert.strictEqual(stored.sha256, 'filesha', 'digest lives in the payload');
    assert.strictEqual(evidenceRows[0].payload_hash, chainStub.hashPayload({ action: 'evidence_file_uploaded', filename: 'a.pdf', sha256: 'filesha' }));
    assert.notStrictEqual(evidenceRows[0].hash, 'filesha', 'the hash column is the link hash, not the file digest');
    assert.strictEqual(evidenceRows[0].storage_key, 'iso-evidence/orgA/x');

    await store.addEvidence({ organization_id: 'orgA', hash: 'ignored', payload: { sha256: 'explicit' } });
    assert.strictEqual(JSON.parse(evidenceRows[1].payload).sha256, 'explicit');
});

test('the nine pre-chain call-site shapes still work: hash + payload, no seq/prev_hash from the caller', async () => {
    // runner.js shape
    const r = await store.addEvidence({ organization_id: 'o', check_id: 'GDPR-Art5-x', subject_type: 'global', subject_id: null, hash: 'h1', payload: { status: 'pass' } });
    // incidents / soa / overview: subject ids as numbers
    const s = await store.addEvidence({ organization_id: 'o', check_id: null, subject_type: 'incident', subject_id: 12, hash: 'h2', payload: { action: 'incident_created' } });
    assert.strictEqual(r.seq, 1);
    assert.strictEqual(s.seq, 2);
    assert.strictEqual(evidenceRows[1].subject_id, 12);
});

test('a row without an organization is stored unchained (seq NULL) — no lock, no head read', async () => {
    const out = await store.addEvidence({ check_id: 'X', payload: { a: 1 } });
    assert.strictEqual(out.seq, null);
    assert.strictEqual(typeof out.hash, 'string');
    assert.strictEqual(evidenceRows[0].organization_id, null);
    assert.ok(!clientSql().some(s => /pg_advisory_xact_lock/.test(s)), 'no advisory lock without an org');
});

test('getChainHead returns {seq, hash} of the newest chained link, or null', async () => {
    assert.strictEqual(await store.getChainHead('orgA'), null);
    await store.addEvidence({ organization_id: 'orgA', payload: { n: 1 } });
    const two = await store.addEvidence({ organization_id: 'orgA', payload: { n: 2 } });
    assert.deepStrictEqual(await store.getChainHead('orgA'), { seq: 2, hash: two.hash });
    assert.strictEqual(await store.getChainHead('orgZ'), null, 'org-scoped');
});

// ── reads ────────────────────────────────────────────────────────────────

test('evidence reads select the chain columns and stay org-scoped', async () => {
    await store.getEvidenceById('orgA', '7');
    await store.getEvidenceHistory('orgA', 'GDPR-Art30-ropa', 5);
    await store.listEvidence('orgA', { limit: 10, offset: 20 });
    for (const c of [...mock.calls.getOne, ...mock.calls.getAll]) {
        assert.match(c.sql, /seq, prev_hash, payload_hash/, 'chain columns selected');
        assert.match(c.sql, /organization_id = \$1/);
        assert.strictEqual(c.params[0], 'orgA');
    }
    const byId = mock.calls.getOne[0];
    assert.strictEqual(byId.params[1], 7, 'id coerced to a number');
});

test('listEvidence filters by regulation via the check-id prefix, clamps limit/offset; countEvidence shares the WHERE', async () => {
    await store.listEvidence('orgA', { regulation: 'DATA_ACT', limit: 5000, offset: -3 });
    const list = mock.calls.getAll[0];
    assert.match(list.sql, /check_id LIKE \$2/);
    assert.strictEqual(list.params[1], 'DATA\\_ACT-%', 'the underscore is escaped so DATA_ACT does not match DATAXACT');
    assert.deepStrictEqual(list.params.slice(2), [1000, 0], 'limit clamped to 1000, offset floored at 0');
    assert.match(list.sql, /ORDER BY captured_at DESC, id DESC/);

    await store.listEvidence('orgA', { checkId: 'X', subjectType: 'soa', subjectId: 9 });
    const filtered = mock.calls.getAll[1];
    assert.match(filtered.sql, /check_id = \$2 AND subject_type = \$3 AND subject_id = \$4/);
    assert.deepStrictEqual(filtered.params.slice(0, 4), ['orgA', 'X', 'soa', '9']);

    await store.addEvidence({ organization_id: 'orgA', payload: {} });
    await store.addEvidence({ organization_id: 'orgB', payload: {} });
    assert.strictEqual(await store.countEvidence('orgA'), 1);
    const cnt = mock.calls.getOne.find(c => /COUNT\(\*\)/.test(c.sql));
    assert.match(cnt.sql, /WHERE organization_id = \$1/);
});

// ── score history ────────────────────────────────────────────────────────

test('recordScoreSnapshot writes scores JSONB next to the legacy three, filling whichever side is missing', async () => {
    await store.recordScoreSnapshot({
        organization_id: 'orgA', overall_score: 70, gdpr_score: 80, aia_score: 60, iso_score: 90,
        pass: 10, warn: 2, fail: 1, na: 3, run_type: 'scheduled',
        scores: { gdpr: 80, aia: 60, iso27001: 90, nis2: 40, 'custom:abc': null },
    });
    const [full] = insertsOf('compliance_score_history');
    assert.match(full.sql, /scores, coverage\)/);
    assert.match(full.sql, /\$11::jsonb/);
    assert.deepStrictEqual(full.params.slice(2, 5), [80, 60, 90]);
    assert.deepStrictEqual(JSON.parse(full.params[10]), { gdpr: 80, aia: 60, iso27001: 90, nis2: 40, 'custom:abc': null });
    assert.strictEqual(full.params[11], null, 'a snapshot that recorded no coverage stores NULL, never an empty "all covered"');

    // only `scores` given → legacy columns derived
    await store.recordScoreSnapshot({ organization_id: 'orgA', scores: { gdpr: 71, aia: 52, iso27001: 93 } });
    const scoresOnly = insertsOf('compliance_score_history')[1];
    assert.deepStrictEqual(scoresOnly.params.slice(2, 5), [71, 52, 93]);

    // only legacy given (old runner) → scores populated from them
    await store.recordScoreSnapshot({ organization_id: 'orgA', gdpr_score: 1, aia_score: 2, iso_score: 3 });
    const legacyOnly = insertsOf('compliance_score_history')[2];
    assert.deepStrictEqual(JSON.parse(legacyOnly.params[10]), { gdpr: 1, aia: 2, iso27001: 3 });
    assert.strictEqual(legacyOnly.params[0], 'orgA');
});

test('getScoreHistory returns scores, synthesising {gdpr, aia, iso27001} for rows with an empty JSONB — no UPDATE', async () => {
    scoreRows.push(
        { organization_id: 'orgA', gdpr_score: 80, aia_score: null, iso_score: 90, scores: {}, captured_at: '2026-01-01' },
        { organization_id: 'orgA', gdpr_score: 81, aia_score: 61, iso_score: 91, scores: null, captured_at: '2026-01-02' },
        { organization_id: 'orgA', gdpr_score: 82, aia_score: 62, iso_score: 92, scores: '{"gdpr":82,"aia":62,"iso27001":92,"nis2":40}', captured_at: '2026-01-03' },
        { organization_id: 'orgB', gdpr_score: 1, aia_score: 1, iso_score: 1, scores: {}, captured_at: '2026-01-03' },
    );
    const rows = await store.getScoreHistory('orgA', 30);
    assert.strictEqual(rows.length, 3, 'org-scoped');
    assert.deepStrictEqual(rows[0].scores, { gdpr: 80, aia: null, iso27001: 90 });
    assert.deepStrictEqual(rows[1].scores, { gdpr: 81, aia: 61, iso27001: 91 });
    assert.deepStrictEqual(rows[2].scores, { gdpr: 82, aia: 62, iso27001: 92, nis2: 40 }, 'stored JSONB (even text-typed) wins');
    assert.strictEqual(rows[0].gdpr_score, 80, 'legacy columns still on the row');
    assert.strictEqual(mock.mutations().length, 0, 'read path never writes');
    assert.match(mock.calls.getAll[0].sql, /, scores, coverage\s+FROM compliance_score_history/);
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
    const [row] = insertsOf('compliance_score_history');
    assert.match(row.sql, /\$12::jsonb/);
    assert.deepStrictEqual(JSON.parse(row.params[11]), coverage);
});

test('getScoreHistory never invents coverage for a row that has none', async () => {
    scoreRows.push(
        // Written before the column existed: no record of what it covered.
        { organization_id: 'orgA', gdpr_score: 100, scores: {}, coverage: null, captured_at: '2026-01-01' },
        // Postgres hands JSONB back as an object; a text-typed driver as a string.
        { organization_id: 'orgA', gdpr_score: 100, scores: {}, coverage: { total: 11, examined: 3, unexamined: 8, complete: false }, captured_at: '2026-01-02' },
        { organization_id: 'orgA', gdpr_score: 100, scores: {}, coverage: '{"total":11,"examined":11,"unexamined":0,"complete":true}', captured_at: '2026-01-03' },
    );
    const rows = await store.getScoreHistory('orgA', 30);
    assert.strictEqual(rows[0].coverage, null, 'an old row is "coverage not recorded", never "everything covered"');
    assert.strictEqual(rows[1].coverage.unexamined, 8);
    assert.strictEqual(rows[1].coverage.complete, false);
    assert.strictEqual(rows[2].coverage.complete, true, 'a text-typed JSONB is parsed, not handed back as a string');
    assert.strictEqual(mock.mutations().length, 0, 'read path never writes');
});

// ── check results ────────────────────────────────────────────────────────

test('recordCheckResult passes framework_code through (null when absent); getLatestPerCheck/getCheckHistory select it', async () => {
    await store.recordCheckResult({ organization_id: 'orgA', check_id: 'CUSTOM-ISAE-1', regulation: 'CUSTOM', status: 'pass', framework_code: 'ISAE' });
    await store.recordCheckResult({ organization_id: 'orgA', check_id: 'GDPR-Art30-ropa', regulation: 'GDPR', status: 'warn' });
    const [custom, gdpr] = insertsOf('compliance_checks');
    assert.match(custom.sql, /framework_code\)/);
    assert.strictEqual(custom.params[11], 'ISAE');
    assert.strictEqual(gdpr.params[11], null);
    assert.strictEqual(custom.params[0], 'orgA');

    await store.getLatestPerCheck('orgA');
    await store.getCheckHistory('orgA', 'GDPR-Art30-ropa', 10);
    for (const c of mock.calls.getAll) {
        assert.match(c.sql, /framework_code/);
        assert.match(c.sql, /organization_id = \$1/);
    }
});
