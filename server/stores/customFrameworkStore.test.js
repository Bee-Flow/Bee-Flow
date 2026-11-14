// @typecheck
/**
 * customFrameworkStore — org-defined frameworks, their items and the
 * append-only attestations, against a real Postgres (PGlite behind db.js's
 * pool, recorded by testUtils/routeHarness.js recordDb) with the store's own
 * schema: the code rule, org scoping on every mutation, the bulk upsert by ref
 * and the supersede-on-attest semantics, read back from the tables.
 *
 * Run: cd server && node --test stores/customFrameworkStore.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { newPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { recordDb } = require('../testUtils/routeHarness');

const pg = newPglite();
const rec = recordDb(undefined, { pg });
const store = require('./customFrameworkStore');

before(() => store.initDB());
after(() => pg.close());
beforeEach(async () => {
    await pg.exec('TRUNCATE compliance_custom_frameworks, compliance_custom_checks, compliance_attestations CASCADE');
    rec.reset();
});

const rowsOf = async (table) => (await pg.query(`SELECT * FROM ${table} ORDER BY created_at, id`)).rows;
const checksOf = async () => (await pg.query('SELECT * FROM compliance_custom_checks ORDER BY ref')).rows;
const attestationsOf = async () => (await pg.query('SELECT * FROM compliance_attestations ORDER BY attested_at, id')).rows;

// ── DDL ──────────────────────────────────────────────────────────────────

test('boot DDL: uuid ids, code unique per org, checks cascade with their framework, attestation index', async () => {
    const a = await insertRow(pg, 'compliance_custom_frameworks', { organization_id: 'orgA', code: 'ACME', name: 'A' });
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(a.attestation_valid_months, 12);
    assert.strictEqual(a.status, 'draft');
    await assert.rejects(() => insertRow(pg, 'compliance_custom_frameworks', { organization_id: 'orgA', code: 'ACME', name: 'B' }), { code: '23505' });
    await insertRow(pg, 'compliance_custom_frameworks', { organization_id: 'orgB', code: 'ACME', name: 'B' });

    const c = await insertRow(pg, 'compliance_custom_checks', { framework_id: a.id, organization_id: 'orgA', ref: '1', title: 't' });
    assert.strictEqual(c.evidence_required, false);
    assert.strictEqual(c.mapped_check_id, null);
    await assert.rejects(() => insertRow(pg, 'compliance_custom_checks', { framework_id: a.id, organization_id: 'orgA', ref: '1', title: 'u' }), { code: '23505' });

    const att = await insertRow(pg, 'compliance_attestations', { organization_id: 'orgA', check_id: 'X', outcome: 'compliant' });
    assert.deepStrictEqual(att.evidence_refs, []);
    assert.strictEqual(att.superseded_at, null);
    const idx = await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_attestations_lookup'`);
    assert.match(idx.rows[0].indexdef, /\(organization_id, check_id, subject_id, attested_at DESC\)/);

    await pg.query('DELETE FROM compliance_custom_frameworks WHERE id = $1', [a.id]);
    assert.strictEqual((await checksOf()).length, 0, 'a framework takes its checks with it');
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
    const [row] = await rowsOf('compliance_custom_frameworks');
    assert.strictEqual(row.organization_id, 'orgA');
    assert.strictEqual(row.created_by, 'u-1');
    assert.strictEqual(row.reference, 'v3');

    await assert.rejects(() => store.createFramework('orgA', { code: 'ACME', name: 'again' }), store.CodeTakenError);
    const other = await store.createFramework('orgB', { code: 'ACME', name: 'same code, other org' });
    assert.strictEqual(other.code, 'ACME', 'uniqueness is per organisation');

    await assert.rejects(() => store.createFramework('orgA', { code: 'x', name: 'n' }), store.InvalidCodeError);
    await assert.rejects(() => store.createFramework('orgA', { code: 'OK', name: '  ' }), /name is required/);
    await assert.rejects(() => store.createFramework('orgA', { code: 'OK', name: 'n', status: 'archived' }), /invalid status/);
    await assert.rejects(() => store.createFramework('orgA', { code: 'OK', name: 'n', attestationValidMonths: 0 }), /attestation_valid_months/);
    await assert.rejects(() => store.createFramework(null, { code: 'OK', name: 'n' }), /organization_id/);
    assert.strictEqual((await rowsOf('compliance_custom_frameworks')).length, 2);
});

test('list/get: org-scoped, archived hidden unless asked, active first, checks_count attached, code lookup', async () => {
    const a = await store.createFramework('orgA', { code: 'A1', name: 'Zeta', status: 'active' });
    const b = await store.createFramework('orgA', { code: 'B1', name: 'Beta' });
    const d = await store.createFramework('orgA', { code: 'D1', name: 'Alpha' });
    await store.createFramework('orgB', { code: 'C1', name: 'C' });
    await store.archiveFramework('orgA', b.id);
    await store.upsertChecks('orgA', a.id, [{ ref: '1', title: 'One' }, { ref: '2', title: 'Two' }]);

    const visible = await store.listFrameworks('orgA');
    assert.deepStrictEqual(visible.map((f) => f.code), ['A1', 'D1'], 'active before draft, archived hidden, orgB never');
    assert.deepStrictEqual(visible.map((f) => f.checks_count), [2, 0]);
    const all = await store.listFrameworks('orgA', { includeArchived: true });
    assert.deepStrictEqual(all.map((f) => f.code).sort(), ['A1', 'B1', 'D1']);

    assert.strictEqual((await store.getFramework('orgA', a.id)).checks_count, 2);
    assert.strictEqual(await store.getFramework('orgB', a.id), null, 'foreign org reads nothing');
    assert.strictEqual(await store.getFramework('orgA', null), null);
    assert.strictEqual((await store.getFrameworkByCode('orgA', 'a1')).id, a.id);
    assert.strictEqual(await store.getFrameworkByCode('orgB', 'a1'), null);
    assert.ok(d);
});

test('updateFramework: whitelisted patch, code immutable, archiving only via archiveFramework, org-scoped', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A', description: 'd', reference: 'r' });
    const out = await store.updateFramework('orgA', fw.id, { name: 'Renamed', status: 'active', attestation_valid_months: 6, reference: null });
    assert.strictEqual(out.name, 'Renamed');
    assert.strictEqual(out.status, 'active');
    assert.strictEqual(out.attestation_valid_months, 6);
    assert.strictEqual(out.description, 'd', 'omitted fields keep their value');
    assert.strictEqual(out.reference, null, 'explicit null clears');

    await assert.rejects(() => store.updateFramework('orgA', fw.id, { code: 'OTHER' }), /code is immutable/);
    await assert.rejects(() => store.updateFramework('orgA', fw.id, { status: 'archived' }), /invalid status/);
    await assert.rejects(() => store.updateFramework('orgA', fw.id, { name: '' }), /name is required/);
    assert.strictEqual(await store.updateFramework('orgB', fw.id, { name: 'hijack' }), null);
    const [row] = await rowsOf('compliance_custom_frameworks');
    assert.strictEqual(row.name, 'Renamed');
    assert.strictEqual(row.code, 'ACME');
});

test('archiveFramework: true once, false again and for a foreign org', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    assert.strictEqual(await store.archiveFramework('orgB', fw.id), false);
    assert.strictEqual((await rowsOf('compliance_custom_frameworks'))[0].status, 'draft');
    assert.strictEqual(await store.archiveFramework('orgA', fw.id), true);
    assert.strictEqual((await rowsOf('compliance_custom_frameworks'))[0].status, 'archived');
    assert.strictEqual(await store.archiveFramework('orgA', fw.id), false);
});

// ── checks ───────────────────────────────────────────────────────────────

test('upsertChecks: bulk by ref, normalises severity/evidence/sort, updates in place, foreign framework → null', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    const list = await store.upsertChecks('orgA', fw.id, [
        { ref: '1.1', title: 'Encryption at rest', severity: 'HIGH', evidence_required: 'true' },
        { ref: '1.2', title: 'MFA for admins', mapped_check_id: 'NIS2-Art21(2)(j)-admin-mfa' },
        { ref: '2.1', title: 'Backups tested', description: 'Quarterly restore test', sort_order: 9 },
    ]);
    assert.strictEqual(list.length, 3);
    const byRef = Object.fromEntries((await checksOf()).map((c) => [c.ref, c]));
    assert.strictEqual(byRef['1.1'].severity, 'high');
    assert.strictEqual(byRef['1.1'].evidence_required, true);
    assert.strictEqual(byRef['1.1'].sort_order, 0);
    assert.strictEqual(byRef['1.2'].severity, 'medium');
    assert.strictEqual(byRef['1.2'].mapped_check_id, 'NIS2-Art21(2)(j)-admin-mfa');
    assert.strictEqual(byRef['1.2'].evidence_required, false);
    assert.strictEqual(byRef['2.1'].sort_order, 9);
    for (const c of Object.values(byRef)) {
        assert.strictEqual(c.organization_id, 'orgA');
        assert.strictEqual(c.framework_id, fw.id);
    }

    // second batch: one update by ref, one new; untouched rows stay
    const again = await store.upsertChecks('orgA', fw.id, [
        { ref: '1.1', title: 'Encryption at rest (AES-256)', severity: 'critical' },
        { ref: '3.1', title: 'Pen test' },
    ]);
    assert.strictEqual(again.length, 4);
    const after1 = (await checksOf()).find((c) => c.ref === '1.1');
    assert.strictEqual(after1.id, byRef['1.1'].id, 'updated in place');
    assert.strictEqual(after1.severity, 'critical');
    assert.strictEqual(after1.title, 'Encryption at rest (AES-256)');

    assert.strictEqual(await store.upsertChecks('orgB', fw.id, [{ ref: 'x', title: 'y' }]), null);
    assert.strictEqual((await checksOf()).length, 4, 'a foreign org adds nothing');
});

test('upsertChecks: the conflict branch only overwrites a row of the same organisation', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    // A row under this framework that belongs to someone else.
    await insertRow(pg, 'compliance_custom_checks', { framework_id: fw.id, organization_id: 'orgB', ref: '9', title: 'theirs' });
    await store.upsertChecks('orgA', fw.id, [{ ref: '9', title: 'ours' }]);
    const [row] = await checksOf();
    assert.strictEqual(row.title, 'theirs');
    assert.strictEqual(row.organization_id, 'orgB');
});

test('upsertChecks validation: ref + title required, severity vocabulary, duplicate refs in a batch, batch cap', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ title: 'no ref' }]), /row 1: ref is required/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ ref: '1', title: '' }]), /title is required/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ ref: '1', title: 't', severity: 'meh' }]), /invalid severity/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, [{ ref: 'a', title: 't' }, { ref: 'A', title: 't' }]), /duplicate ref/);
    await assert.rejects(() => store.upsertChecks('orgA', fw.id, Array.from({ length: 501 }, (_, i) => ({ ref: String(i), title: 't' }))), /at most 500/);
    assert.strictEqual((await checksOf()).length, 0, 'validation happens before any write');
});

test('listChecks / getCheck / deleteCheck are org-scoped; delete leaves attestations alone', async () => {
    const fw = await store.createFramework('orgA', { code: 'ACME', name: 'A' });
    await store.upsertChecks('orgA', fw.id, [{ ref: '2', title: 'Two', sort_order: 0 }, { ref: '1', title: 'One', sort_order: 0 }, { ref: '0', title: 'Zero', sort_order: 5 }]);
    await store.attest('orgA', { checkId: store.customCheckId('ACME', '1'), outcome: 'compliant' });

    assert.deepStrictEqual((await store.listChecks('orgA', fw.id)).map((c) => c.ref), ['1', '2', '0'], 'sort_order, then ref');
    assert.deepStrictEqual(await store.listChecks('orgB', fw.id), []);
    const one = (await checksOf()).find((c) => c.ref === '1');
    assert.strictEqual((await store.getCheck('orgA', one.id)).title, 'One');
    assert.strictEqual(await store.getCheck('orgB', one.id), null);

    assert.strictEqual(await store.deleteCheck('orgB', one.id), false);
    assert.strictEqual((await checksOf()).length, 3);
    assert.strictEqual(await store.deleteCheck('orgA', one.id), true);
    assert.strictEqual((await checksOf()).length, 2);

    const att = await attestationsOf();
    assert.strictEqual(att.length, 1, 'history is append-only: the attestation outlives its check');
    assert.strictEqual(att[0].check_id, store.customCheckId('ACME', '1'));
    assert.ok(!rec.queries.some((q) => /DELETE[\s\S]*compliance_attestations/i.test(q)), 'no DELETE ever names the attestation table');
});

// ── attestations ─────────────────────────────────────────────────────────

test('attest: supersedes the previous latest for (check, subject) in one transaction; evidence refs allow-listed', async () => {
    const id = store.customCheckId('ACME', '1.1');
    const first = await store.attest('orgA', { checkId: id, outcome: 'partial', statement: 'Working on it', attestedBy: 'u-1' });
    assert.strictEqual(first.outcome, 'partial');
    assert.strictEqual(first.superseded_at, null);
    await store.attest('orgB', { checkId: id, outcome: 'partial' });
    rec.reset();

    const second = await store.attest('orgA', {
        checkId: id, outcome: 'compliant', statement: 'Done', attestedBy: 'u-2', expiresAt: '2027-09-14T00:00:00.000Z',
        evidenceRefs: /** @type {any} */ ([
            { evidence_id: 12, sha256: 'ABC', filename: 'policy.pdf', subject_email: 'leak@example.test' },
            { note: 'no id, no hash' },
            'string',
        ]),
    });
    assert.strictEqual(second.outcome, 'compliant');
    assert.strictEqual(second.expires_at.toISOString(), '2027-09-14T00:00:00.000Z');
    assert.deepStrictEqual(second.evidence_refs, [{ evidence_id: 12, sha256: 'abc', filename: 'policy.pdf' }], 'only the three allowed keys survive');
    const rows = await attestationsOf();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.ok(byId[first.id].superseded_at instanceof Date, 'previous latest superseded');
    assert.strictEqual(byId[second.id].superseded_at, null);
    assert.strictEqual(rows.find((r) => r.organization_id === 'orgB').superseded_at, null, 'another organisation\'s chain is untouched');

    const verbs = rec.all.map((s) => s.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepStrictEqual(verbs, ['BEGIN', 'UPDATE compliance_attestations', 'INSERT INTO', 'COMMIT'], 'supersede + insert under one transaction');
});

test('attest: subjects are separate chains; validation of outcome / check id / expiry', async () => {
    const id = 'MACHINERY-Art18-instructions';
    const a7 = await store.attest('orgA', { checkId: id, subjectId: 'automation:7', outcome: 'compliant' });
    const a8 = await store.attest('orgA', { checkId: id, subjectId: 'automation:8', outcome: 'non_compliant' });
    const none = await store.attest('orgA', { checkId: id, outcome: 'compliant' });
    assert.ok((await attestationsOf()).every((a) => !a.superseded_at), 'different subjects (and no subject) do not supersede each other');
    await store.attest('orgA', { checkId: id, subjectId: 'automation:7', outcome: 'not_applicable' });
    const byId = Object.fromEntries((await attestationsOf()).map((r) => [r.id, r]));
    assert.ok(byId[a7.id].superseded_at, 'same subject supersedes');
    assert.strictEqual(byId[a8.id].superseded_at, null);
    assert.strictEqual(byId[none.id].superseded_at, null);
    await store.attest('orgA', { checkId: id, outcome: 'partial' });
    assert.ok((await attestationsOf()).find((r) => r.id === none.id).superseded_at, 'a null subject is its own chain (IS NOT DISTINCT FROM)');

    await assert.rejects(() => store.attest('orgA', { checkId: id, outcome: 'maybe' }), /invalid outcome/);
    await assert.rejects(() => store.attest('orgA', { outcome: 'compliant' }), /checkId is required/);
    await assert.rejects(() => store.attest('orgA', { checkId: id, outcome: 'compliant', expiresAt: 'later' }), /expires_at/);
    await assert.rejects(() => store.attest(null, { checkId: id, outcome: 'compliant' }), /organization_id/);
});

test('latestAttestation / listAttestations / listExpiring / listLatestByPrefix read the right rows', async () => {
    const id = 'CUSTOM-ACME-1';
    const old = await store.attest('orgA', { checkId: id, outcome: 'partial' });
    const cur = await store.attest('orgA', { checkId: id, outcome: 'compliant' });
    await store.attest('orgA', { checkId: id, subjectId: 'S', outcome: 'compliant' });
    await store.attest('orgB', { checkId: id, outcome: 'non_compliant' });

    assert.strictEqual((await store.latestAttestation('orgA', id, null)).id, cur.id);
    assert.strictEqual(await store.latestAttestation('orgA', 'CUSTOM-ACME-2', null), null);
    const hist = await store.listAttestations('orgA', id, null, { limit: 5 });
    assert.deepStrictEqual(hist.map((r) => r.id).sort(), [old.id, cur.id].sort(), 'history includes superseded rows, one subject, one org');
    assert.strictEqual((await store.listAttestations('orgA', id, null, { limit: 1 })).length, 1);

    const soon = await store.attest('orgA', { checkId: 'CUSTOM-ACME-9', outcome: 'compliant', expiresAt: new Date(Date.now() + 5 * 864e5) });
    await store.attest('orgA', { checkId: 'CUSTOM-ACME-8', outcome: 'compliant', expiresAt: new Date(Date.now() + 40 * 864e5) });
    const past = await store.attest('orgA', { checkId: 'CUSTOM-ACME-7', outcome: 'compliant', expiresAt: new Date(Date.now() - 864e5) });
    assert.deepStrictEqual((await store.listExpiring('orgA', 14)).map((r) => r.id), [past.id, soon.id], 'already expired first, then the ones inside the window');

    await store.attest('orgA', { checkId: 'CUSTOM-ACXME-1', outcome: 'compliant' });
    await store.attest('orgA', { checkId: 'CUSTOM-AC_ME-1', outcome: 'compliant' });
    const pre = await store.listLatestByPrefix('orgA', 'CUSTOM-AC_ME-');
    assert.deepStrictEqual(pre.map((r) => r.check_id), ['CUSTOM-AC_ME-1'], 'LIKE metacharacters in the prefix are literal');
    const acme = await store.listLatestByPrefix('orgA', 'CUSTOM-ACME-');
    assert.deepStrictEqual(acme.map((r) => r.check_id), ['CUSTOM-ACME-1', 'CUSTOM-ACME-1', 'CUSTOM-ACME-7', 'CUSTOM-ACME-8', 'CUSTOM-ACME-9'], 'only current rows, per check');
});

test('isCurrent: superseded or expired rows do not count', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    assert.strictEqual(store.isCurrent(null, now), false);
    assert.strictEqual(store.isCurrent({ superseded_at: '2026-01-01T00:00:00Z', expires_at: null }, now), false);
    assert.strictEqual(store.isCurrent({ superseded_at: null, expires_at: null }, now), true);
    assert.strictEqual(store.isCurrent({ superseded_at: null, expires_at: '2026-09-14T12:00:00Z' }, now), false);
    assert.strictEqual(store.isCurrent({ superseded_at: null, expires_at: '2026-09-15T00:00:00Z' }, now), true);
});
