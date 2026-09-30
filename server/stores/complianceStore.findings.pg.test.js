'use strict';

/**
 * complianceStore — the tables the Compliance Center writes for itself since
 * the project checks landed, against a REAL Postgres (@electric-sql/pglite
 * behind db.js's pool, testUtils/pglitePool.js). The store runs its own schema
 * init and SQL; nothing is mocked.
 *
 *   - listLatestScopes / getLatestForChecks: the newest row per slot, and only
 *     for the named check, only for the org asked, only when fresh;
 *   - finding states: one decision per (org, check, scope), replaced in place,
 *     cleared on re-open, the vocabulary closed;
 *   - subject registrations: a processing record per (org, kind, id);
 *   - hint dismissals: per person and project, dismiss vs snooze;
 *   - the two new settings columns and their defaults.
 *
 * Run: cd server && node --test stores/complianceStore.findings.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./complianceStore');

before(async () => { await store.initDB(); });
after(close);

async function row(orgId, checkId, scopeType, scopeId, status, at, evidence = {}) {
    await pg.query(`
        INSERT INTO compliance_checks (organization_id, check_id, regulation, severity, status, evidence, scope_type, scope_id, run_at)
        VALUES ($1, $2, 'GDPR', 'medium', $3, $4::jsonb, $5, $6, $7)
    `, [orgId, checkId, status, JSON.stringify(evidence), scopeType, scopeId, at]);
}

test('listLatestScopes answers the newest row of every slot of one check, for one org', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    const now = new Date().toISOString();
    await row('org1', 'C-1', 'per-source', 'project:a', 'warn', old);
    await row('org1', 'C-1', 'per-source', 'project:a', 'pass', now);
    await row('org1', 'C-1', 'per-source', 'project:b', 'fail', now);
    await row('org1', 'C-2', 'per-source', 'project:c', 'fail', now);
    await row('org2', 'C-1', 'per-source', 'project:z', 'fail', now);

    const rows = await store.listLatestScopes('org1', 'C-1');
    const bySlot = Object.fromEntries(rows.map(r => [r.scope_id, r.status]));
    assert.deepStrictEqual(bySlot, { 'project:a': 'pass', 'project:b': 'fail' });
});

test('getLatestForChecks reads only the named checks and leaves stale rows out', async () => {
    const stale = new Date(Date.now() - 10 * 86400_000).toISOString();
    const fresh = new Date().toISOString();
    await row('org3', 'H-1', 'global', null, 'warn', fresh, { offenders: [{ project_id: 'p1', count: 2 }] });
    await row('org3', 'H-2', 'global', null, 'fail', stale);
    await row('org3', 'OTHER', 'global', null, 'fail', fresh);

    const rows = await store.getLatestForChecks('org3', ['H-1', 'H-2']);
    assert.deepStrictEqual(rows.map(r => r.check_id), ['H-1']);
    assert.deepStrictEqual(rows[0].evidence.offenders, [{ project_id: 'p1', count: 2 }]);
    assert.deepStrictEqual(await store.getLatestForChecks('org3', []), []);
});

test('a finding state is one row per slot, replaced in place and cleared on re-open', async () => {
    const first = await store.setFindingState('org1', {
        checkId: 'C-1', scopeKey: 'project:b', fingerprint: 'f1', state: 'acknowledged', actorId: 'admin',
    });
    assert.strictEqual(first.state, 'acknowledged');
    assert.strictEqual(first.until, null);

    const until = new Date(Date.now() + 7 * 86400_000).toISOString();
    const second = await store.setFindingState('org1', {
        checkId: 'C-1', scopeKey: 'project:b', fingerprint: 'f2', state: 'snoozed', until, reason: 'legal hold', actorId: 'dpo',
    });
    assert.strictEqual(second.state, 'snoozed');
    assert.strictEqual(second.reason, 'legal hold');
    assert.strictEqual(second.until, until);

    const all = await store.listFindingStates('org1');
    assert.strictEqual(all.length, 1, 'the second decision replaced the first');
    assert.strictEqual(all[0].fingerprint, 'f2');
    assert.deepStrictEqual(await store.listFindingStates('org2'), [], 'another org sees none of it');

    assert.strictEqual(await store.clearFindingState('org1', 'C-1', 'project:b'), true);
    assert.strictEqual(await store.clearFindingState('org1', 'C-1', 'project:b'), false);
    assert.deepStrictEqual(await store.listFindingStates('org1'), []);
});

test('an unknown finding state is refused before any SQL', async () => {
    await assert.rejects(
        store.setFindingState('org1', { checkId: 'C-1', scopeKey: 'global', fingerprint: 'x', state: 'resolved' }),
        /Unknown finding state/,
    );
});

test('a processing record is one row per subject and re-confirming moves confirmed_at', async () => {
    const a = await store.upsertSubjectRegistration('org1', {
        subjectKind: 'project', subjectId: 'p1', purpose: 'Client files', lawfulBasis: 'contract', retentionDays: 730, confirmedBy: 'dpo',
    });
    assert.strictEqual(a.lawful_basis, 'contract');
    assert.strictEqual(a.retention_days, 730);
    await new Promise(r => setTimeout(r, 5));
    const b = await store.upsertSubjectRegistration('org1', {
        subjectKind: 'project', subjectId: 'p1', purpose: 'Client files', lawfulBasis: 'legal_obligation', retentionDays: null, confirmedBy: 'admin',
    });
    assert.strictEqual(b.lawful_basis, 'legal_obligation');
    assert.strictEqual(b.retention_days, null);
    assert.ok(Date.parse(b.confirmed_at) >= Date.parse(a.confirmed_at));

    assert.strictEqual((await store.listSubjectRegistrations('org1', 'project')).length, 1);
    assert.deepStrictEqual(await store.listSubjectRegistrations('org2', 'project'), []);
    assert.strictEqual(await store.deleteSubjectRegistration('org1', 'project', 'p1'), true);
    assert.deepStrictEqual(await store.listSubjectRegistrations('org1', 'project'), []);
});

test('a hint dismissal keeps its fingerprint; a snooze keeps its date and clears the dismissal', async () => {
    await store.recordHintDismissal('u1', 'p1', 'project_files_unscanned', { fingerprint: 'fp-3' });
    let d = await store.getHintDismissals('u1', 'p1');
    assert.strictEqual(d.project_files_unscanned.fingerprint, 'fp-3');
    assert.ok(d.project_files_unscanned.dismissedAt);
    assert.strictEqual(d.project_files_unscanned.snoozedUntil, null);

    const until = new Date(Date.now() + 30 * 86400_000).toISOString();
    await store.recordHintDismissal('u1', 'p1', 'project_files_unscanned', { fingerprint: 'fp-3', snoozedUntil: until });
    d = await store.getHintDismissals('u1', 'p1');
    assert.strictEqual(d.project_files_unscanned.snoozedUntil, until);
    assert.strictEqual(d.project_files_unscanned.dismissedAt, null);

    assert.deepStrictEqual(await store.getHintDismissals('u2', 'p1'), {}, 'per person');
    assert.deepStrictEqual(await store.getHintDismissals('u1', 'p2'), {}, 'per project');
});

test('the project settings default to "hints on" and no retention window of their own', async () => {
    const s = await store.getSettings('fresh-org');
    assert.strictEqual(s.project_owner_hints_enabled, true);
    assert.strictEqual(s.project_retention_days, null);

    const saved = await store.saveSettings('fresh-org', { project_retention_days: 90, project_owner_hints_enabled: false });
    assert.strictEqual(saved.project_retention_days, 90);
    assert.strictEqual(saved.project_owner_hints_enabled, false);

    assert.throws(() => store.sanitizeSettingsPatch({ project_retention_days: 5 }), /project_retention_days/);
    assert.deepStrictEqual(store.sanitizeSettingsPatch({ project_owner_hints_enabled: 'true' }), { project_owner_hints_enabled: true });
});

// ── hint dismissals are erased with the person, and pruned with the project ──
//
// The rows (person id, project id, when they acted) had no delete path at all:
// account erasure left them behind, and so did deleting a project.

test('account erasure forgets every hint the person put away, in every project, and nobody else\'s', async () => {
    await store.recordHintDismissal('u-erase', 'pe1', 'project_files_unscanned', { fingerprint: 'a' });
    await store.recordHintDismissal('u-erase', 'pe2', 'project_orphaned_content', { snoozedUntil: new Date(Date.now() + 86400_000).toISOString() });
    await store.recordHintDismissal('u-keep', 'pe1', 'project_files_unscanned', { fingerprint: 'a' });

    assert.deepStrictEqual(await store.eraseHintDismissals('u-erase'), { rows: 2 });
    assert.deepStrictEqual(await store.getHintDismissals('u-erase', 'pe1'), {});
    assert.deepStrictEqual(await store.getHintDismissals('u-erase', 'pe2'), {});
    assert.ok((await store.getHintDismissals('u-keep', 'pe1')).project_files_unscanned);
    assert.deepStrictEqual(await store.eraseHintDismissals(''), { rows: 0 }, 'no id erases nothing');
});

test('the sweep prunes the dismissals whose project or person no longer exists', async () => {
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);
        INSERT INTO projects (id) VALUES ('p-live');
        INSERT INTO users (id) VALUES ('u-live');
    `);
    await store.recordHintDismissal('u-live', 'p-live', 'project_files_unscanned', { fingerprint: 'a' });
    await store.recordHintDismissal('u-live', 'p-deleted', 'project_files_unscanned', { fingerprint: 'a' });
    await store.recordHintDismissal('u-gone', 'p-live', 'project_files_unscanned', { fingerprint: 'a' });

    const { rows } = await store.pruneHintDismissals();
    assert.ok(rows >= 2);
    assert.ok((await store.getHintDismissals('u-live', 'p-live')).project_files_unscanned, 'a live person in a live project keeps theirs');
    assert.deepStrictEqual(await store.getHintDismissals('u-live', 'p-deleted'), {}, 'the project was deleted');
    assert.deepStrictEqual(await store.getHintDismissals('u-gone', 'p-live'), {}, 'the person was deleted');
});
