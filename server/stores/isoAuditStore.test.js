/**
 * ISO audit store tests — status-transition stamps, NC lifecycle stamps,
 * field whitelisting, finding insert params.
 * Fake db injected via require.cache (same pattern as soaStore.test.js).
 *
 * Run: cd server && node --test stores/isoAuditStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const calls = { run: [], getOne: [], getAll: [] };
let oneResult = null;
let allResult = [];

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => { calls.run.push({ sql, params }); return { rowCount: 1, rows: [{ id: 1 }] }; },
    getOne: async (sql, params) => { calls.getOne.push({ sql, params }); return oneResult; },
    getAll: async (sql, params) => { calls.getAll.push({ sql, params }); return allResult; },
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./isoAuditStore');

beforeEach(() => {
    calls.run.length = 0;
    calls.getOne.length = 0;
    calls.getAll.length = 0;
    oneResult = null;
    allResult = [];
});

// ---------------------------------------------------------------- 9.2 audits

test('updateAudit stamps started_at/closed_at on transition, first time only', async () => {
    oneResult = { id: 7, organization_id: 'orgA', title: 'Q3 audit', status: 'planned', started_at: null, closed_at: null };
    await store.updateAudit('orgA', 7, { status: 'in_progress' });
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_audits'));
    assert.ok(upd, 'UPDATE issued');
    // status param drives both stamps server-side; never client-supplied times
    assert.strictEqual(upd.params[6], 'in_progress');
    assert.ok(upd.sql.includes(`started_at = CASE WHEN $7 = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END`));
    assert.ok(upd.sql.includes(`closed_at = CASE WHEN $7 = 'closed' AND closed_at IS NULL THEN NOW() ELSE closed_at END`));
});

test('updateAudit rejects unknown status back to the existing one', async () => {
    oneResult = { id: 7, organization_id: 'orgA', title: 'Q3 audit', status: 'in_progress' };
    await store.updateAudit('orgA', 7, { status: 'abandoned', evil_field: 'DROP TABLE' });
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_audits'));
    assert.strictEqual(upd.params[6], 'in_progress', 'invalid status falls back to existing');
    assert.ok(!upd.sql.includes('evil_field'), 'unknown fields never reach SQL');
    assert.ok(!upd.params.includes('DROP TABLE'), 'unknown values never reach params');
});

test('updateAudit returns null for a different org (org-scoped)', async () => {
    oneResult = null; // getAudit finds nothing in this org
    const out = await store.updateAudit('orgB', 7, { status: 'closed' });
    assert.strictEqual(out, null);
    assert.strictEqual(calls.run.length, 0, 'no UPDATE without an org-owned row');
});

test('createAudit whitelists fields and starts planned', async () => {
    await store.createAudit('orgA', {
        title: 'Annual internal audit',
        scope_note: 'Full Annex A',
        auditor_user_id: 'u-eva',
        planned_at: '2026-09-01',
        status: 'closed',            // ignored — audits always start planned
        evil_field: 'DROP TABLE',
    }, 'actor1');
    const ins = calls.run.find(c => c.sql.includes('INSERT INTO iso_audits'));
    assert.ok(ins.sql.includes(`'planned'`), 'status is hardcoded to planned');
    assert.deepEqual(ins.params, ['orgA', 'Annual internal audit', 'Full Annex A', 'u-eva', '2026-09-01', 'actor1']);
});

// ------------------------------------------------------------ audit findings

test('addFinding inserts whitelisted params in order and defaults severity', async () => {
    await store.addFinding('orgA', 7, {
        control_ref: 'A.5.15',
        clause: '9.2',
        severity: 'not-a-severity',
        description: 'Access reviews not documented for Q2',
        evidence_ref: 'sha256:abc123',
        evil_field: 'DROP TABLE',
    });
    const ins = calls.run.find(c => c.sql.includes('INSERT INTO iso_audit_findings'));
    assert.ok(ins, 'finding INSERT issued');
    // [orgId, auditId, control_ref, clause, severity, description, evidence_ref, nonconformity_id]
    assert.deepEqual(ins.params, ['orgA', 7, 'A.5.15', '9.2', 'observation', 'Access reviews not documented for Q2', 'sha256:abc123', null]);
    assert.ok(!ins.sql.includes('evil_field'));
});

test('addFinding requires a description', async () => {
    await assert.rejects(() => store.addFinding('orgA', 7, { severity: 'major' }), /description is required/);
});

// --------------------------------------------------- 9.3 management reviews

test('createReview snapshots inputs/attendees as JSON and keeps decisions human-typed', async () => {
    await store.createReview('orgA', {
        held_at: '2026-07-01T09:00:00Z',
        attendees: ['u-tom', 'u-eva'],
        inputs: { score_trend: [80, 85], open_ncs: 2 },
        decisions: 'Budget approved for MFA rollout.',
        evil_field: 'DROP TABLE',
    }, 'actor1');
    const ins = calls.run.find(c => c.sql.includes('INSERT INTO iso_management_reviews'));
    assert.deepEqual(ins.params, [
        'orgA', '2026-07-01T09:00:00Z',
        JSON.stringify(['u-tom', 'u-eva']),
        JSON.stringify({ score_trend: [80, 85], open_ncs: 2 }),
        'Budget approved for MFA rollout.', null, 'actor1',
    ]);
    assert.ok(!ins.sql.includes('evil_field'));
});

// ------------------------------------------------------- 10 NC / CAPA

test('createNonconformity whitelists source/severity and always opens open', async () => {
    await store.createNonconformity('orgA', {
        title: 'Backup restore untested',
        source: 'not-a-source',
        severity: 'catastrophic',
        due_at: '2026-08-15',
        owner_user_id: 'u-tom',
        status: 'closed',            // ignored — NCs always start open
    }, 'actor2');
    const ins = calls.run.find(c => c.sql.includes('INSERT INTO iso_nonconformities'));
    assert.ok(ins.sql.includes(`'open'`), 'status is hardcoded to open');
    // [orgId, title, description, source, severity, corrective_action, due_at, owner, created_by]
    assert.deepEqual(ins.params, ['orgA', 'Backup restore untested', null, 'manual', 'minor', null, '2026-08-15', 'u-tom', 'actor2']);
});

test('updateNonconformity: closing stamps closed_at server-side', async () => {
    oneResult = { id: 3, organization_id: 'orgA', status: 'effectiveness_review', closed_at: null };
    await store.updateNonconformity('orgA', 3, { status: 'closed' }, 'actor3');
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_nonconformities'));
    assert.strictEqual(upd.params[9], 'closed');
    assert.ok(upd.sql.includes(`closed_at = CASE WHEN $10 = 'closed' AND closed_at IS NULL THEN NOW() ELSE closed_at END`));
    assert.strictEqual(upd.params[10], false, 'closing alone never confirms effectiveness');
});

test('updateNonconformity: confirm_effectiveness stamps WHO confirmed, first time only', async () => {
    oneResult = { id: 3, organization_id: 'orgA', status: 'effectiveness_review', effectiveness_confirmed_by: null, effectiveness_confirmed_at: null };
    await store.updateNonconformity('orgA', 3, { status: 'closed', confirm_effectiveness: true }, 'u-tom');
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_nonconformities'));
    assert.strictEqual(upd.params[10], true, 'confirm flag passed');
    assert.strictEqual(upd.params[11], 'u-tom', 'actor recorded as the confirmer');
    assert.ok(upd.sql.includes('effectiveness_confirmed_by = CASE WHEN $11 AND effectiveness_confirmed_by IS NULL THEN $12 ELSE effectiveness_confirmed_by END'));
    assert.ok(upd.sql.includes('effectiveness_confirmed_at = CASE WHEN $11 AND effectiveness_confirmed_at IS NULL THEN NOW() ELSE effectiveness_confirmed_at END'));
});

test('updateNonconformity whitelists fields and rejects bad status/severity', async () => {
    oneResult = { id: 3, organization_id: 'orgA', status: 'corrective_action' };
    await store.updateNonconformity('orgA', 3, {
        status: 'wontfix',
        severity: 'catastrophic',
        corrective_action: 'Quarterly restore drill scheduled',
        effectiveness_confirmed_at: '1999-01-01',    // client may NOT set stamps
        evil_field: 'DROP TABLE',
    }, 'actor4');
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_nonconformities'));
    assert.strictEqual(upd.params[9], 'corrective_action', 'invalid status falls back to existing');
    assert.strictEqual(upd.params[4], null, 'invalid severity dropped');
    assert.strictEqual(upd.params[5], 'Quarterly restore drill scheduled');
    assert.strictEqual(upd.params[10], false, 'no silent effectiveness confirm');
    assert.ok(!upd.params.includes('1999-01-01'), 'client-supplied stamp never reaches SQL');
    assert.ok(!upd.sql.includes('evil_field'));
});

// ----------------------------------------------------------- 6.2 objectives

test('createObjective + updateObjective whitelist and validate status', async () => {
    await store.createObjective('orgA', {
        title: '99.9% uptime', measure: 'monthly uptime', target: '>= 99.9%',
        review_due_at: '2026-12-31', owner_user_id: 'u-eva', evil_field: 'x',
    }, 'actor5');
    const ins = calls.run.find(c => c.sql.includes('INSERT INTO iso_objectives'));
    assert.ok(ins.sql.includes(`'active'`), 'objectives start active');
    assert.deepEqual(ins.params, ['orgA', '99.9% uptime', 'monthly uptime', '>= 99.9%', '2026-12-31', 'u-eva', 'actor5']);

    calls.run.length = 0;
    oneResult = { id: 5, organization_id: 'orgA', status: 'active' };
    await store.updateObjective('orgA', 5, { status: 'achieved', evil_field: 'x' });
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_objectives'));
    assert.strictEqual(upd.params[5], 'achieved');
    assert.ok(!upd.sql.includes('evil_field'));

    calls.run.length = 0;
    await store.updateObjective('orgA', 5, { status: 'exploded' });
    const upd2 = calls.run.find(c => c.sql.includes('UPDATE iso_objectives'));
    assert.strictEqual(upd2.params[5], 'active', 'invalid status falls back to existing');
});

// ---------------------------------------------------------------- listings

test('list functions are org-scoped and listFindings filters per audit', async () => {
    await store.listAudits('orgA');
    await store.listReviews('orgA');
    await store.listNonconformities('orgA');
    await store.listNonconformities('orgA', { status: 'open' });
    await store.listObjectives('orgA');
    await store.listFindings('orgA', 7);
    await store.listFindings('orgA');
    for (const c of calls.getAll) {
        assert.ok(c.sql.includes('organization_id = $1'), 'every list query is org-scoped');
        assert.strictEqual(c.params[0], 'orgA');
    }
    assert.deepEqual(calls.getAll[3].params, ['orgA', 'open'], 'NC status filter applied');
    assert.deepEqual(calls.getAll[5].params, ['orgA', 7], 'findings filtered by audit');
    assert.ok(calls.getAll[5].sql.includes('audit_id = $2'));
    assert.ok(!calls.getAll[6].sql.includes('audit_id'), 'no audit filter without auditId');
});
