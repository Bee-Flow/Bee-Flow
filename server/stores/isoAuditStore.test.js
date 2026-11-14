/**
 * ISO audit store tests — status-transition stamps, NC lifecycle stamps,
 * field whitelisting, finding rows — against a real Postgres (PGlite behind
 * db.js's pool, testUtils/pglitePool.js) with the store's own schema.
 *
 * Run: cd server && node --test stores/isoAuditStore.test.js
 */

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const store = require('./isoAuditStore');

const TABLES = ['iso_audits', 'iso_audit_findings', 'iso_management_reviews', 'iso_nonconformities', 'iso_objectives'];
before(async () => { await store.initDB(); });
after(close);
beforeEach(async () => { await pg.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`); });

const one = async (table, id) => (await pg.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

// ---------------------------------------------------------------- 9.2 audits

test('updateAudit stamps started_at/closed_at on transition, first time only', async () => {
    const a = await insertRow(pg, 'iso_audits', { organization_id: 'orgA', title: 'Q3 audit', status: 'planned' });
    await store.updateAudit('orgA', a.id, { status: 'in_progress' });
    const started = await one('iso_audits', a.id);
    assert.strictEqual(started.status, 'in_progress');
    assert.ok(started.started_at, 'started_at stamped server-side');
    assert.strictEqual(started.closed_at, null);

    await pg.query("UPDATE iso_audits SET started_at = '2020-01-01T00:00:00Z' WHERE id = $1", [a.id]);
    await store.updateAudit('orgA', a.id, { status: 'in_progress' });
    assert.strictEqual(new Date((await one('iso_audits', a.id)).started_at).toISOString(), '2020-01-01T00:00:00.000Z', 'first time only');

    await store.updateAudit('orgA', a.id, { status: 'closed' });
    const closed = await one('iso_audits', a.id);
    assert.ok(closed.closed_at, 'closed_at stamped');
    await pg.query("UPDATE iso_audits SET closed_at = '2021-01-01T00:00:00Z' WHERE id = $1", [a.id]);
    await store.updateAudit('orgA', a.id, { status: 'closed', title: 'renamed' });
    const again = await one('iso_audits', a.id);
    assert.strictEqual(new Date(again.closed_at).toISOString(), '2021-01-01T00:00:00.000Z', 'closed_at never re-stamped');
    assert.strictEqual(again.title, 'renamed');
});

test('updateAudit rejects unknown status back to the existing one', async () => {
    const a = await insertRow(pg, 'iso_audits', { organization_id: 'orgA', title: 'Q3 audit', status: 'in_progress' });
    const out = await store.updateAudit('orgA', a.id, { status: 'abandoned', evil_field: 'DROP TABLE' });
    assert.strictEqual(out.status, 'in_progress', 'invalid status falls back to existing');
    assert.ok(!('evil_field' in out), 'unknown fields never reach SQL');
    assert.ok(!Object.values(out).includes('DROP TABLE'), 'unknown values never reach a column');
    assert.strictEqual(out.title, 'Q3 audit', 'COALESCE keeps untouched fields');
});

test('updateAudit returns null for a different org (org-scoped)', async () => {
    const a = await insertRow(pg, 'iso_audits', { organization_id: 'orgA', title: 'Q3 audit', status: 'planned' });
    const out = await store.updateAudit('orgB', a.id, { status: 'closed' });
    assert.strictEqual(out, null);
    assert.strictEqual((await one('iso_audits', a.id)).status, 'planned', 'no UPDATE without an org-owned row');
});

test('createAudit whitelists fields and starts planned', async () => {
    const row = await store.createAudit('orgA', {
        title: 'Annual internal audit',
        scope_note: 'Full Annex A',
        auditor_user_id: 'u-eva',
        planned_at: '2026-09-01',
        status: 'closed',            // ignored — audits always start planned
        evil_field: 'DROP TABLE',
    }, 'actor1');
    const stored = await one('iso_audits', row.id);
    assert.strictEqual(stored.status, 'planned', 'status is fixed to planned');
    assert.deepEqual(
        [stored.organization_id, stored.title, stored.scope_note, stored.auditor_user_id, new Date(stored.planned_at).toISOString().slice(0, 10), stored.created_by],
        ['orgA', 'Annual internal audit', 'Full Annex A', 'u-eva', '2026-09-01', 'actor1'],
    );
    assert.strictEqual(stored.started_at, null);
});

// ------------------------------------------------------------ audit findings

test('addFinding stores the whitelisted fields and defaults severity', async () => {
    const audit = await insertRow(pg, 'iso_audits', { organization_id: 'orgA', title: 'Q3 audit', status: 'in_progress' });
    const row = await store.addFinding('orgA', audit.id, {
        control_ref: 'A.5.15',
        clause: '9.2',
        severity: 'not-a-severity',
        description: 'Access reviews not documented for Q2',
        evidence_ref: 'sha256:abc123',
        evil_field: 'DROP TABLE',
    });
    const f = await one('iso_audit_findings', row.id);
    assert.deepEqual(
        [f.organization_id, f.audit_id, f.control_ref, f.clause, f.severity, f.description, f.evidence_ref, f.nonconformity_id],
        ['orgA', audit.id, 'A.5.15', '9.2', 'observation', 'Access reviews not documented for Q2', 'sha256:abc123', null],
    );
});

test('addFinding onto an audit of another organisation stores nothing', async () => {
    const audit = await insertRow(pg, 'iso_audits', { organization_id: 'orgB', title: 'B audit', status: 'in_progress' });
    assert.strictEqual(await store.addFinding('orgA', audit.id, { description: 'x' }), null);
    assert.strictEqual((await pg.query('SELECT count(*)::int AS n FROM iso_audit_findings')).rows[0].n, 0);
});

test('addFinding requires a description', async () => {
    await assert.rejects(() => store.addFinding('orgA', 7, { severity: 'major' }), /description is required/);
});

// --------------------------------------------------- 9.3 management reviews

test('createReview snapshots inputs/attendees as JSON and keeps decisions human-typed', async () => {
    const row = await store.createReview('orgA', {
        held_at: '2026-07-01T09:00:00Z',
        attendees: ['u-tom', 'u-eva'],
        inputs: { score_trend: [80, 85], open_ncs: 2 },
        decisions: 'Budget approved for MFA rollout.',
        evil_field: 'DROP TABLE',
    }, 'actor1');
    const r = await one('iso_management_reviews', row.id);
    assert.strictEqual(new Date(r.held_at).toISOString(), '2026-07-01T09:00:00.000Z');
    assert.deepEqual(r.attendees, ['u-tom', 'u-eva']);
    assert.deepEqual(r.inputs, { score_trend: [80, 85], open_ncs: 2 });
    assert.strictEqual(r.decisions, 'Budget approved for MFA rollout.');
    assert.strictEqual(r.minutes_evidence_ref, null);
    assert.strictEqual(r.created_by, 'actor1');
});

// ------------------------------------------------------- 10 NC / CAPA

test('createNonconformity whitelists source/severity and always opens open', async () => {
    const row = await store.createNonconformity('orgA', {
        title: 'Backup restore untested',
        source: 'not-a-source',
        severity: 'catastrophic',
        due_at: '2026-08-15',
        owner_user_id: 'u-tom',
        status: 'closed',            // ignored — NCs always start open
    }, 'actor2');
    const nc = await one('iso_nonconformities', row.id);
    assert.strictEqual(nc.status, 'open', 'status is fixed to open');
    assert.deepEqual(
        [nc.organization_id, nc.title, nc.description, nc.source, nc.severity, nc.corrective_action, new Date(nc.due_at).toISOString().slice(0, 10), nc.owner_user_id, nc.created_by],
        ['orgA', 'Backup restore untested', null, 'manual', 'minor', null, '2026-08-15', 'u-tom', 'actor2'],
    );
});

const seedNc = (over) => insertRow(pg, 'iso_nonconformities', { organization_id: 'orgA', title: 'NC', ...over });

test('updateNonconformity: closing stamps closed_at server-side, first time only, and never confirms effectiveness', async () => {
    const nc = await seedNc({ status: 'effectiveness_review' });
    await store.updateNonconformity('orgA', nc.id, { status: 'closed' }, 'actor3');
    const closed = await one('iso_nonconformities', nc.id);
    assert.strictEqual(closed.status, 'closed');
    assert.ok(closed.closed_at);
    assert.strictEqual(closed.effectiveness_confirmed_by, null, 'closing alone never confirms effectiveness');
    assert.strictEqual(closed.effectiveness_confirmed_at, null);

    await pg.query("UPDATE iso_nonconformities SET closed_at = '2020-01-01T00:00:00Z' WHERE id = $1", [nc.id]);
    await store.updateNonconformity('orgA', nc.id, { status: 'closed' }, 'actor3');
    assert.strictEqual(new Date((await one('iso_nonconformities', nc.id)).closed_at).toISOString(), '2020-01-01T00:00:00.000Z');
});

test('updateNonconformity: confirm_effectiveness stamps WHO confirmed, first time only', async () => {
    const nc = await seedNc({ status: 'effectiveness_review' });
    await store.updateNonconformity('orgA', nc.id, { status: 'closed', confirm_effectiveness: true }, 'u-tom');
    const first = await one('iso_nonconformities', nc.id);
    assert.strictEqual(first.effectiveness_confirmed_by, 'u-tom', 'actor recorded as the confirmer');
    assert.ok(first.effectiveness_confirmed_at);

    await store.updateNonconformity('orgA', nc.id, { confirm_effectiveness: true }, 'u-eva');
    const second = await one('iso_nonconformities', nc.id);
    assert.strictEqual(second.effectiveness_confirmed_by, 'u-tom', 'a second confirm never re-attributes');
    assert.deepStrictEqual(second.effectiveness_confirmed_at, first.effectiveness_confirmed_at);
});

test('updateNonconformity whitelists fields and rejects bad status/severity', async () => {
    const nc = await seedNc({ status: 'corrective_action', severity: 'major' });
    await store.updateNonconformity('orgA', nc.id, {
        status: 'wontfix',
        severity: 'catastrophic',
        corrective_action: 'Quarterly restore drill scheduled',
        effectiveness_confirmed_at: '1999-01-01',    // client may NOT set stamps
        evil_field: 'DROP TABLE',
    }, 'actor4');
    const row = await one('iso_nonconformities', nc.id);
    assert.strictEqual(row.status, 'corrective_action', 'invalid status falls back to existing');
    assert.strictEqual(row.severity, 'major', 'invalid severity dropped, existing kept');
    assert.strictEqual(row.corrective_action, 'Quarterly restore drill scheduled');
    assert.strictEqual(row.effectiveness_confirmed_by, null, 'no silent effectiveness confirm');
    assert.strictEqual(row.effectiveness_confirmed_at, null, 'client-supplied stamp never reaches the row');
});

test('updateNonconformity of another org returns null and writes nothing', async () => {
    const nc = await seedNc({ status: 'open' });
    assert.strictEqual(await store.updateNonconformity('orgB', nc.id, { status: 'closed' }, 'x'), null);
    assert.strictEqual((await one('iso_nonconformities', nc.id)).status, 'open');
});

// ----------------------------------------------------------- 6.2 objectives

test('createObjective + updateObjective whitelist and validate status', async () => {
    const created = await store.createObjective('orgA', {
        title: '99.9% uptime', measure: 'monthly uptime', target: '>= 99.9%',
        review_due_at: '2026-12-31', owner_user_id: 'u-eva', evil_field: 'x',
    }, 'actor5');
    const o = await one('iso_objectives', created.id);
    assert.strictEqual(o.status, 'active', 'objectives start active');
    assert.deepEqual(
        [o.organization_id, o.title, o.measure, o.target, new Date(o.review_due_at).toISOString().slice(0, 10), o.owner_user_id, o.created_by],
        ['orgA', '99.9% uptime', 'monthly uptime', '>= 99.9%', '2026-12-31', 'u-eva', 'actor5'],
    );

    await store.updateObjective('orgA', o.id, { status: 'achieved', evil_field: 'x' });
    assert.strictEqual((await one('iso_objectives', o.id)).status, 'achieved');

    await store.updateObjective('orgA', o.id, { status: 'exploded' });
    assert.strictEqual((await one('iso_objectives', o.id)).status, 'achieved', 'invalid status falls back to existing');
    assert.strictEqual((await one('iso_objectives', o.id)).measure, 'monthly uptime');
});

// ---------------------------------------------------------------- listings

test('list functions are org-scoped and listFindings filters per audit', async () => {
    for (const org of ['orgA', 'orgB']) {
        await insertRow(pg, 'iso_audits', { organization_id: org, title: `${org} audit` });
        await insertRow(pg, 'iso_management_reviews', { organization_id: org, held_at: '2026-01-01' });
        await seedNc({ organization_id: org, status: 'open', title: `${org} open` });
        await seedNc({ organization_id: org, status: 'closed', title: `${org} closed` });
        await insertRow(pg, 'iso_objectives', { organization_id: org, title: `${org} obj` });
        await insertRow(pg, 'iso_audit_findings', { organization_id: org, audit_id: 7, description: `${org} f7` });
        await insertRow(pg, 'iso_audit_findings', { organization_id: org, audit_id: 8, description: `${org} f8` });
    }
    const orgs = (rows) => [...new Set(rows.map(r => r.organization_id))];
    assert.deepEqual(orgs(await store.listAudits('orgA')), ['orgA']);
    assert.deepEqual(orgs(await store.listReviews('orgA')), ['orgA']);
    assert.deepEqual(orgs(await store.listObjectives('orgA')), ['orgA']);
    assert.deepEqual((await store.listNonconformities('orgA')).map(r => r.title).sort(), ['orgA closed', 'orgA open']);
    assert.deepEqual((await store.listNonconformities('orgA', { status: 'open' })).map(r => r.title), ['orgA open'], 'NC status filter applied');
    assert.deepEqual((await store.listNonconformities('orgA', { status: 'bogus' })).length, 2, 'an unknown status filters nothing');
    assert.deepEqual((await store.listFindings('orgA', 7)).map(r => r.description), ['orgA f7'], 'findings filtered by audit');
    assert.deepEqual((await store.listFindings('orgA')).map(r => r.description).sort(), ['orgA f7', 'orgA f8'], 'no audit filter without auditId');
});
