/**
 * customFrameworkStore — org-defined frameworks, their items and the
 * append-only attestations. Recording db double (testUtils/mockDb): the
 * assertions pin the code rule, org scoping on every mutation, the bulk
 * upsert by ref and the supersede-on-attest semantics.
 *
 * Run: cd server && node --test --test-force-exit stores/customFrameworkStore.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

const frameworks = [];
const checks = [];
const attestations = [];
let seq = 1;
const uuid = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;

function parseInsert(sql, params, defaults) {
    const cols = sql.match(/\(([\s\S]*?)\)\s*VALUES/i)[1].split(',').map(s => s.trim());
    const vals = sql.match(/VALUES\s*\(([\s\S]*?)\)/i)[1].split(',').map(s => s.trim());
    const row = { id: uuid(), created_at: new Date(), updated_at: new Date(), ...defaults };
    cols.forEach((c, i) => {
        const p = vals[i].match(/^\$(\d+)/);
        row[c] = p ? params[Number(p[1]) - 1] : vals[i];
    });
    return row;
}

const mock = createRecordingDb({
    tables: {
        compliance_custom_frameworks: frameworks,
        compliance_custom_checks: checks,
        compliance_attestations: attestations,
    },
    matchers: {
        // SELECTs join/alias (`f.organization_id = $1`) — the equality matcher
        // reads `organization_id = $1` fine, but the subselect for
        // checks_count names compliance_custom_checks first; route by verb.
        compliance_custom_frameworks(rows, sql, params) {
            if (/^SELECT/i.test(sql) && /FROM compliance_custom_frameworks f/.test(sql)) {
                let out = rows.filter(r => r.organization_id === params[0]);
                if (/f\.id = \$2/.test(sql)) out = out.filter(r => r.id === params[1]);
                if (/f\.code = \$2/.test(sql)) out = out.filter(r => r.code === params[1]);
                if (/f\.status <> 'archived'/.test(sql)) out = out.filter(r => r.status !== 'archived');
                return out.map(r => ({ ...r, checks_count: checks.filter(c => c.framework_id === r.id).length }));
            }
            return undefined;
        },
    },
    onQuery(sql, params) {
        if (/^INSERT INTO compliance_custom_frameworks/i.test(sql)) {
            const row = parseInsert(sql, params, {});
            if (frameworks.some(f => f.organization_id === row.organization_id && f.code === row.code)) {
                const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e;
            }
            frameworks.push(row);
            return { rows: [{ ...row }], rowCount: 1 };
        }
        if (/^INSERT INTO compliance_custom_checks/i.test(sql)) {
            const row = parseInsert(sql, params, {});
            const hit = checks.find(c => c.framework_id === row.framework_id && c.ref === row.ref);
            if (hit) {
                if (hit.organization_id !== params[1]) return { rows: [], rowCount: 0 };
                Object.assign(hit, row, { id: hit.id, created_at: hit.created_at });
            } else checks.push(row);
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO compliance_attestations/i.test(sql)) {
            const row = parseInsert(sql, params, { attested_at: new Date(), superseded_at: null });
            if (typeof row.evidence_refs === 'string') row.evidence_refs = JSON.parse(row.evidence_refs);
            attestations.push(row);
            return { rows: [{ ...row }], rowCount: 1 };
        }
        if (/^UPDATE compliance_attestations SET superseded_at = NOW\(\)/i.test(sql)) {
            const [org, checkId, subject] = params;
            let n = 0;
            for (const a of attestations) {
                if (a.organization_id === org && a.check_id === checkId && (a.subject_id ?? null) === (subject ?? null) && !a.superseded_at) {
                    a.superseded_at = new Date(); n++;
                }
            }
            return { rows: [], rowCount: n };
        }
        if (/^UPDATE compliance_custom_frameworks/i.test(sql)) {
            const [org, id] = params;
            const hit = frameworks.find(f => f.organization_id === org && f.id === id);
            if (!hit) return { rows: [], rowCount: 0 };
            if (/status = 'archived'/.test(sql)) {
                if (hit.status === 'archived') return { rows: [], rowCount: 0 };
                hit.status = 'archived'; return { rows: [], rowCount: 1 };
            }
            const set = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)[1];
            for (const m of set.matchAll(/([a-z_]+) = \$(\d+)/g)) hit[m[1]] = params[Number(m[2]) - 1];
            return { rows: [], rowCount: 1 };
        }
        if (/^DELETE FROM compliance_custom_checks/i.test(sql)) {
            const [org, id] = params;
            const i = checks.findIndex(c => c.organization_id === org && c.id === id);
            if (i < 0) return { rows: [], rowCount: 0 };
            checks.splice(i, 1);
            return { rows: [], rowCount: 1 };
        }
        // Deletes against the attestation history are modelled FAITHFULLY even
        // though the store must never issue one. Without this branch the default
        // dispatch filters and *copies* rows, never touching the backing array,
        // so "history is append-only" would read green against a store that hard
        // deletes attestations. Any `col = $n` equality in the WHERE is honoured;
        // a DELETE with no WHERE empties the table, as Postgres would.
        if (/^DELETE FROM compliance_attestations/i.test(sql)) {
            const where = sql.match(/\bWHERE\b([\s\S]*)/i);
            const conds = [...(where ? where[1] : '').matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)]
                .map(m => [m[1], params[Number(m[2]) - 1]]);
            let n = 0;
            for (let i = attestations.length - 1; i >= 0; i--) {
                if (conds.every(([col, val]) => attestations[i][col] === val)) { attestations.splice(i, 1); n++; }
            }
            return { rows: [], rowCount: n };
        }
        return undefined;
    },
});
const restore = installResolveStub({ '../db': mock.db });
const store = require('./customFrameworkStore');

let bootDdl = '';
before(async () => {
    await store.initDB();
    bootDdl = mock.calls.exec.map(c => c.sql).join('\n');
});
after(() => restore());
beforeEach(() => { frameworks.length = 0; checks.length = 0; attestations.length = 0; seq = 1; mock.reset(); });

const mutations = () => mock.mutations();

// ── DDL ──────────────────────────────────────────────────────────────────

test('boot DDL: three tables per CHECK-CATALOGUE §3 — uuid ids, code unique per org, checks cascade, attestation index', () => {
    assert.match(bootDdl, /CREATE TABLE IF NOT EXISTS compliance_custom_frameworks \(\s+id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    assert.match(bootDdl, /UNIQUE \(organization_id, code\)/);
    assert.match(bootDdl, /attestation_valid_months INTEGER NOT NULL DEFAULT 12/);
    assert.match(bootDdl, /framework_id UUID NOT NULL REFERENCES compliance_custom_frameworks\(id\) ON DELETE CASCADE/);
    assert.match(bootDdl, /UNIQUE \(framework_id, ref\)/);
    assert.match(bootDdl, /evidence_required BOOLEAN NOT NULL DEFAULT false/);
    assert.match(bootDdl, /mapped_check_id TEXT/);
    assert.match(bootDdl, /CREATE TABLE IF NOT EXISTS compliance_attestations/);
    assert.match(bootDdl, /evidence_refs JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(bootDdl, /superseded_at TIMESTAMPTZ/);
    assert.match(bootDdl, /CREATE INDEX IF NOT EXISTS idx_attestations_lookup ON compliance_attestations\(organization_id, check_id, subject_id, attested_at DESC\)/);
});

// ── code + id helpers ────────────────────────────────────────────────────

test('normalizeCode: upper-cases and enforces ^[A-Z0-9_]{2,24}$', () => {
    assert.strictEqual(store.normalizeCode(' acme_q1 '), 'ACME_Q1');
    for (const bad of ['A', 'a-b', 'ACME Q', 'X'.repeat(25), '', null, 'ÄCME']) {
        assert.throws(() => store.normalizeCode(bad), store.InvalidCodeError, String(bad));
    }
    assert.throws(() => store.normalizeCode('a-b'), /custom_framework_code_invalid|invalid framework code/);
});

test('customCheckId: CUSTOM-<CODE>-<REFSLUG>; dots survive, other punctuation collapses to a dash', () => {
    assert.strictEqual(store.customCheckId('acme', 'A.5.1'), 'CUSTOM-ACME-A.5.1');
    assert.strictEqual(store.customCheckId('ACME', ' 4 (b) / ii '), 'CUSTOM-ACME-4-b-ii');
    assert.strictEqual(store.refSlug('--x--'), 'x');
    assert.throws(() => store.customCheckId('ACME', '---'), /ref is required/);
    assert.throws(() => store.customCheckId('bad code', 'x'), store.InvalidCodeError);
});

// ── frameworks ───────────────────────────────────────────────────────────

test('createFramework: validates code + name, defaults draft/12 months, org-scoped insert; duplicate code → CodeTakenError', async () => {
    const fw = await store.createFramework('orgA', { code: 'acme', name: ' ACME supplier questionnaire ', reference: 'v3', createdBy: 'u-1' });
    assert.strictEqual(fw.code, 'ACME');
    assert.strictEqual(fw.name, 'ACME supplier questionnaire');
    assert.strictEqual(fw.status, 'draft');
    assert.strictEqual(fw.attestation_valid_months, 12);
    const ins = mutations()[0];
    assert.strictEqual(ins.params[0], 'orgA');
    assert.strictEqual(ins.params[7], 'u-1');

    await assert.rejects(() => store.createFramework('orgA', { code: 'ACME', name: 'again' }), store.CodeTakenError);
    const other = await store.createFramework('orgB', { code: 'ACME', name: 'same code, other org' });
    assert.strictEqual(other.code, 'ACME', 'uniqueness is per organisation');

    await assert.rejects(() => store.createFramework('orgA', { code: 'x', name: 'n' }), store.InvalidCodeError);
    await assert.rejects(() => store.createFramework('orgA', { code: 'OK', name: '  ' }), /name is required/);
    await assert.rejects(() => store.createFramework('orgA', { code: 'OK', name: 'n', status: 'archived' }), /invalid status/);
    await assert.rejects(() => store.createFramework('orgA', { code: 'OK', name: 'n', attestationValidMonths: 0 }), /attestation_valid_months/);
    await assert.rejects(() => store.createFramework(null, { code: 'OK', name: 'n' }), /organization_id/);
});

test('list/get: org-scoped, archived hidden unless asked, checks_count attached, code lookup', async () => {
    const a = await store.createFramework('orgA', { code: 'A1', name: 'A', status: 'active' });
    const b = await store.createFramework('orgA', { code: 'B1', name: 'B' });
    await store.createFramework('orgB', { code: 'C1', name: 'C' });
    await store.archiveFramework('orgA', b.id);
    mock.reset();

    const visible = await store.listFrameworks('orgA');
    assert.deepStrictEqual(visible.map(f => f.code), ['A1']);
    assert.match(mock.calls.getAll[0].sql, /WHERE f\.organization_id = \$1 AND f\.status <> 'archived'/);
    const all = await store.listFrameworks('orgA', { includeArchived: true });
    assert.deepStrictEqual(all.map(f => f.code).sort(), ['A1', 'B1']);

    assert.strictEqual((await store.getFramework('orgA', a.id)).checks_count, 0);
    assert.strictEqual(await store.getFramework('orgB', a.id), null, 'foreign org reads nothing');
    assert.strictEqual(await store.getFramework('orgA', null), null);
    assert.strictEqual((await store.getFrameworkByCode('orgA', 'a1')).id, a.id);
});

test('updateFramework: whitelisted patch, code immutable, archiving only via archiveFramework, org-scoped', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A', description: 'd' });
    mock.reset();
    const out = await store.updateFramework('orgA', fw.id, { name: 'Renamed', status: 'active', attestation_valid_months: 6, reference: null });
    assert.strictEqual(out.name, 'Renamed');
    assert.strictEqual(out.status, 'active');
    assert.strictEqual(out.attestation_valid_months, 6);
    assert.strictEqual(out.description, 'd', 'omitted fields keep their value');
    assert.strictEqual(out.reference, null, 'explicit null clears');
    const upd = mutations().find(m => /UPDATE compliance_custom_frameworks/.test(m.sql));
    assert.match(upd.sql, /WHERE organization_id = \$1 AND id = \$2/);
    assert.deepStrictEqual(upd.params.slice(0, 2), ['orgA', fw.id]);

    await assert.rejects(() => store.updateFramework('orgA', fw.id, { code: 'OTHER' }), /code is immutable/);
    await assert.rejects(() => store.updateFramework('orgA', fw.id, { status: 'archived' }), /invalid status/);
    await assert.rejects(() => store.updateFramework('orgA', fw.id, { name: '' }), /name is required/);
    assert.strictEqual(await store.updateFramework('orgB', fw.id, { name: 'hijack' }), null);
    assert.strictEqual(frameworks[0].name, 'Renamed');
});

test('archiveFramework: true once, false again and for a foreign org', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    mock.reset();
    assert.strictEqual(await store.archiveFramework('orgB', fw.id), false);
    assert.strictEqual(frameworks[0].status, 'draft');
    assert.strictEqual(await store.archiveFramework('orgA', fw.id), true);
    assert.strictEqual(await store.archiveFramework('orgA', fw.id), false);
    for (const m of mutations()) assert.match(m.sql, /WHERE organization_id = \$1 AND id = \$2/);
});

// ── checks ───────────────────────────────────────────────────────────────

test('upsertChecks: bulk by ref, normalises severity/evidence/sort, updates in place, foreign framework → null', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    mock.reset();
    const list = await store.upsertChecks('orgA', fw.id, [
        { ref: '1.1', title: 'Encryption at rest', severity: 'HIGH', evidence_required: 'true' },
        { ref: '1.2', title: 'MFA for admins', mapped_check_id: 'NIS2-Art21(2)(j)-admin-mfa' },
        { ref: '2.1', title: 'Backups tested', description: 'Quarterly restore test', sort_order: 9 },
    ]);
    assert.strictEqual(list.length, 3);
    const byRef = Object.fromEntries(checks.map(c => [c.ref, c]));
    assert.strictEqual(byRef['1.1'].severity, 'high');
    assert.strictEqual(byRef['1.1'].evidence_required, true);
    assert.strictEqual(byRef['1.1'].sort_order, 0);
    assert.strictEqual(byRef['1.2'].severity, 'medium');
    assert.strictEqual(byRef['1.2'].mapped_check_id, 'NIS2-Art21(2)(j)-admin-mfa');
    assert.strictEqual(byRef['1.2'].evidence_required, false);
    assert.strictEqual(byRef['2.1'].sort_order, 9);
    const inserts = mutations().filter(m => /INSERT INTO compliance_custom_checks/.test(m.sql));
    assert.strictEqual(inserts.length, 3);
    for (const m of inserts) {
        assert.match(m.sql, /ON CONFLICT \(framework_id, ref\) DO UPDATE SET/);
        assert.match(m.sql, /WHERE compliance_custom_checks\.organization_id = \$2/, 'the conflict branch is org-guarded');
        assert.strictEqual(m.params[1], 'orgA');
        assert.strictEqual(m.params[0], fw.id);
    }

    // second batch: one update by ref, one new; untouched rows stay
    const firstId = byRef['1.1'].id;
    const again = await store.upsertChecks('orgA', fw.id, [
        { ref: '1.1', title: 'Encryption at rest (AES-256)', severity: 'critical' },
        { ref: '3.1', title: 'Pen test' },
    ]);
    assert.strictEqual(again.length, 4);
    assert.strictEqual(checks.find(c => c.ref === '1.1').id, firstId, 'updated in place');
    assert.strictEqual(checks.find(c => c.ref === '1.1').severity, 'critical');

    assert.strictEqual(await store.upsertChecks('orgB', fw.id, [{ ref: 'x', title: 'y' }]), null);
    assert.strictEqual(checks.length, 4, 'a foreign org adds nothing');
});

test('upsertChecks validation: ref + title required, severity vocabulary, duplicate refs in a batch, batch cap', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ title: 'no ref' }]), /row 1: ref is required/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ ref: '1', title: '' }]), /title is required/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ ref: '1', title: 't', severity: 'meh' }]), /invalid severity/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ ref: 'a', title: 't' }, { ref: 'A', title: 't' }]), /duplicate ref/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, Array.from({ length: 501 }, (_, i) => ({ ref: String(i), title: 't' }))), /at most 500/);
    assert.strictEqual(checks.length, 0, 'validation happens before any write');
});

test('listChecks / getCheck / deleteCheck are org-scoped; delete leaves attestations alone', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    await store.upsertChecks('orgA', fw.id, [{ ref: '1', title: 'One' }, { ref: '2', title: 'Two' }]);
    await store.attest('orgA', { checkId: store.customCheckId('ACME', '1'), outcome: 'compliant' });
    mock.reset();

    await store.listChecks('orgA', fw.id);
    assert.match(mock.calls.getAll[0].sql, /WHERE organization_id = \$1 AND framework_id = \$2\s+ORDER BY sort_order ASC, ref ASC/);
    await store.getCheck('orgA', checks[0].id);
    assert.match(mock.calls.getOne[0].sql, /WHERE c\.organization_id = \$1 AND c\.id = \$2/);

    assert.strictEqual(await store.deleteCheck('orgB', checks[0].id), false);
    assert.strictEqual(checks.length, 2);
    assert.strictEqual(await store.deleteCheck('orgA', checks[0].id), true);
    assert.strictEqual(checks.length, 1);

    // Append-only, proven two ways. The double now really removes rows on a
    // DELETE against compliance_attestations (see onQuery), so the surviving
    // row is a fact about what the store issued, not about the double copying
    // rows; and the statement log is asserted to hold no such DELETE at all.
    const del = mutations().filter(m => /^DELETE/.test(m.sql.trim()));
    assert.ok(del.length >= 1, 'a DELETE really ran — the guards below are not vacuous');
    assert.strictEqual(attestations.length, 1, 'history is append-only: the attestation outlives its check');
    assert.strictEqual(attestations[0].check_id, store.customCheckId('ACME', '1'), 'and it is the deleted check\'s own attestation');
    assert.ok(!del.some(m => /compliance_attestations/i.test(m.sql)), 'no DELETE ever names the attestation table');
    for (const m of del) assert.match(m.sql, /WHERE organization_id = \$1 AND id = \$2/);
});

// ── attestations ─────────────────────────────────────────────────────────

test('attest: supersedes the previous latest for (check, subject) in one transaction; evidence refs allow-listed', async () => {
    const id = store.customCheckId('ACME', '1.1');
    const first = await store.attest('orgA', { checkId: id, outcome: 'partial', statement: 'Working on it', attestedBy: 'u-1' });
    assert.strictEqual(first.outcome, 'partial');
    assert.strictEqual(first.superseded_at, null);
    mock.reset();

    const second = await store.attest('orgA', {
        checkId: id, outcome: 'compliant', statement: 'Done', attestedBy: 'u-2', expiresAt: '2027-09-14T00:00:00.000Z',
        evidenceRefs: [
            { evidence_id: 12, sha256: 'ABC', filename: 'policy.pdf', subject_email: 'leak@example.test' },
            { note: 'no id, no hash' },
            'string',
        ],
    });
    assert.strictEqual(second.outcome, 'compliant');
    assert.strictEqual(second.expires_at.toISOString(), '2027-09-14T00:00:00.000Z');
    assert.deepStrictEqual(second.evidence_refs, [{ evidence_id: 12, sha256: 'abc', filename: 'policy.pdf' }], 'only the three allowed keys survive');
    assert.ok(attestations[0].superseded_at instanceof Date, 'previous latest superseded');
    assert.strictEqual(attestations[1].superseded_at, null);

    const stmts = mock.calls.client.map(c => c.sql.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepStrictEqual(stmts, ['BEGIN', 'UPDATE compliance_attestations', 'INSERT INTO', 'COMMIT'], 'supersede + insert under one transaction');
    const sup = mock.calls.client[1];
    assert.match(sup.sql, /WHERE organization_id = \$1 AND check_id = \$2 AND subject_id IS NOT DISTINCT FROM \$3 AND superseded_at IS NULL/);
    assert.deepStrictEqual(sup.params, ['orgA', id, null]);
    assert.strictEqual(mock.calls.client[2].params[0], 'orgA');
});

test('attest: subjects are separate chains; validation of outcome / check id / expiry', async () => {
    const id = 'MACHINERY-Art18-instructions';
    await store.attest('orgA', { checkId: id, subjectId: 'automation:7', outcome: 'compliant' });
    await store.attest('orgA', { checkId: id, subjectId: 'automation:8', outcome: 'non_compliant' });
    assert.ok(attestations.every(a => !a.superseded_at), 'different subjects do not supersede each other');
    await store.attest('orgA', { checkId: id, subjectId: 'automation:7', outcome: 'not_applicable' });
    assert.ok(attestations[0].superseded_at, 'same subject supersedes');
    assert.strictEqual(attestations[1].superseded_at, null);

    await assert.rejects(() => store.attest('orgA', { checkId: id, outcome: 'maybe' }), /invalid outcome/);
    await assert.rejects(() => store.attest('orgA', { outcome: 'compliant' }), /checkId is required/);
    await assert.rejects(() => store.attest('orgA', { checkId: id, outcome: 'compliant', expiresAt: 'later' }), /expires_at/);
    await assert.rejects(() => store.attest(null, { checkId: id, outcome: 'compliant' }), /organization_id/);
});

test('latestAttestation / listAttestations / listExpiring / listLatestByPrefix: scoped statements', async () => {
    await store.latestAttestation('orgA', 'CUSTOM-ACME-1', null);
    const latest = mock.calls.getOne[0];
    assert.match(latest.sql, /WHERE organization_id = \$1 AND check_id = \$2 AND subject_id IS NOT DISTINCT FROM \$3 AND superseded_at IS NULL/);
    assert.match(latest.sql, /ORDER BY attested_at DESC\s+LIMIT 1/);
    assert.deepStrictEqual(latest.params, ['orgA', 'CUSTOM-ACME-1', null]);

    await store.listAttestations('orgA', 'CUSTOM-ACME-1', 'S', { limit: 5 });
    const hist = mock.calls.getAll[0];
    assert.match(hist.sql, /WHERE organization_id = \$1 AND check_id = \$2 AND subject_id IS NOT DISTINCT FROM \$3\s+ORDER BY attested_at DESC/);
    assert.ok(!/superseded_at IS NULL/.test(hist.sql), 'history includes superseded rows');
    assert.deepStrictEqual(hist.params, ['orgA', 'CUSTOM-ACME-1', 'S', 5]);

    await store.listExpiring('orgA', 14);
    const exp = mock.calls.getAll[1];
    assert.match(exp.sql, /superseded_at IS NULL\s+AND expires_at IS NOT NULL AND expires_at < NOW\(\) \+ \(\$2 \|\| ' days'\)::interval/);
    assert.deepStrictEqual(exp.params, ['orgA', '14']);

    await store.listLatestByPrefix('orgA', 'CUSTOM-AC_ME-');
    const pre = mock.calls.getAll[2];
    assert.match(pre.sql, /check_id LIKE \$2 AND superseded_at IS NULL/);
    assert.deepStrictEqual(pre.params, ['orgA', 'CUSTOM-AC\\_ME-%'], 'LIKE metacharacters escaped');
});

test('isCurrent: superseded or expired rows do not count', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    assert.strictEqual(store.isCurrent(null, now), false);
    assert.strictEqual(store.isCurrent({ superseded_at: '2026-01-01T00:00:00Z', expires_at: null }, now), false);
    assert.strictEqual(store.isCurrent({ superseded_at: null, expires_at: null }, now), true);
    assert.strictEqual(store.isCurrent({ superseded_at: null, expires_at: '2026-09-14T12:00:00Z' }, now), false);
    assert.strictEqual(store.isCurrent({ superseded_at: null, expires_at: '2026-09-15T00:00:00Z' }, now), true);
});

test('every mutation names the organisation as its first bind', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    await store.upsertChecks('orgA', fw.id, [{ ref: '1', title: 'One' }]);
    await store.updateFramework('orgA', fw.id, { name: 'B' });
    await store.attest('orgA', { checkId: 'CUSTOM-ACME-1', outcome: 'compliant' });
    await store.deleteCheck('orgA', checks[0].id);
    await store.archiveFramework('orgA', fw.id);
    const list = mutations();
    assert.ok(list.length >= 7);
    for (const m of list) {
        // the check upsert binds framework_id first and the org second, by design
        const orgIdx = /INSERT INTO compliance_custom_checks/.test(m.sql) ? 1 : 0;
        assert.strictEqual(m.params[orgIdx], 'orgA', m.sql.trim().slice(0, 60));
    }
});
