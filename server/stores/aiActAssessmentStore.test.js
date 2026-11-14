/**
 * aiActAssessmentStore — append-only attestations per automation/agent, on a
 * real Postgres (the boot ladder's schema on PGlite, testUtils/pgliteTemplate.js
 * ladderPglite, behind db.js's pool): org scoping, newest-per-target, the
 * 12-month default expiry, the live-target filter and the pure `isCurrent` rule.
 *
 * Run: cd server && node --test stores/aiActAssessmentStore.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./aiActAssessmentStore');

before(async () => {
    await store.initDB();
    await pg.exec(`
        INSERT INTO users (id, username, "organizationId") VALUES ('u1', 'u1', 'orgA'), ('u2', 'u2', 'orgB');
        INSERT INTO automations (id, user_id, title, definition_json, organization_id) VALUES
            ('a1', 'u1', 'Live', '{}', 'orgA'),
            ('a-legacy', 'u1', 'Org via owner', '{}', NULL),
            ('a-trash', 'u1', 'Trashed', '{}', 'orgA'),
            ('a-b', 'u2', 'Other org', '{}', 'orgB');
        UPDATE automations SET deleted_at = NOW() WHERE id = 'a-trash';
        INSERT INTO agents (id, name, owner_id, organization_id) VALUES ('ag-1', 'Agent', 'u1', 'orgA');
    `);
});
after(close);
beforeEach(() => pg.exec('DELETE FROM compliance_ai_act_assessments'));

const MONTH_MS_MIN = 28 * 86400 * 1000;

const count = async () => (await pg.query('SELECT COUNT(*)::int AS n FROM compliance_ai_act_assessments')).rows[0].n;

test('boot creates the table and the per-target index', async () => {
    const idx = await pg.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_ai_act_assess_target'");
    assert.match(idx.rows[0].indexdef, /\(organization_id, target_kind, target_id, created_at DESC\)/);
    await store.initDB();
    assert.strictEqual(await count(), 0, 'boot writes no assessment');
});

test('record: inserts org-scoped with jsonb signals/answers, expiry defaults to +12 months', async () => {
    const out = await store.record('orgA', 'automation', 42, {
        signals: { contains_ai: true, customer_facing: true },
        answers: { art50: { interacts: true, disclosure: true } },
        outcome: 'transparency',
        attestedBy: 'u-1',
    });
    const [row] = (await pg.query('SELECT * FROM compliance_ai_act_assessments')).rows;
    assert.strictEqual(row.organization_id, 'orgA');
    assert.strictEqual(row.target_kind, 'automation');
    assert.strictEqual(row.target_id, '42', 'target id stored as text');
    assert.deepStrictEqual(row.signals, { contains_ai: true, customer_facing: true });
    assert.deepStrictEqual(row.answers, { art50: { interacts: true, disclosure: true } });
    assert.strictEqual(row.outcome, 'transparency');
    assert.strictEqual(row.attested_by, 'u-1');
    const attested = new Date(row.attested_at), expires = new Date(row.expires_at);
    assert.ok(expires.getTime() - attested.getTime() >= 12 * MONTH_MS_MIN, 'roughly a year later');
    assert.strictEqual(expires.getUTCMonth(), attested.getUTCMonth());
    assert.strictEqual(out.outcome, 'transparency');
    assert.ok(store.isCurrent(out));
});

test('record: source and evidence from the automation\'s own check; an unknown source is not stored', async () => {
    const auto = await store.record('orgA', 'automation', 'a1', { outcome: 'minimal', attestedBy: 'bee', source: 'auto', evidence: { v: 1, questions: { usesAi: { answer: 'yes' } } } });
    assert.strictEqual(auto.source, 'auto');
    assert.deepStrictEqual(auto.evidence, { v: 1, questions: { usesAi: { answer: 'yes' } } });
    // The hub passes neither; an unknown source is not stored.
    const hub = await store.record('orgA', 'automation', 'a1', { outcome: 'minimal', source: 'whatever', evidence: ['x'] });
    assert.strictEqual(hub.source, null);
    assert.strictEqual(hub.evidence, null);
});

test('record: explicit null expiry is evergreen; explicit date is kept; garbage rejected', async () => {
    const a = await store.record('orgA', 'agent', 'ag-1', { outcome: 'not_applicable', expiresAt: null });
    assert.strictEqual(a.expires_at, null);
    assert.ok(store.isCurrent(a), 'no expiry = current');
    const b = await store.record('orgA', 'agent', 'ag-1', { outcome: 'minimal', expiresAt: '2030-01-01T00:00:00.000Z' });
    assert.strictEqual(new Date(b.expires_at).toISOString(), '2030-01-01T00:00:00.000Z');
    await assert.rejects(() => store.record('orgA', 'agent', 'ag-1', { outcome: 'minimal', expiresAt: 'someday' }), /expires_at/);
});

test('record guards: org, kind, target, outcome vocabulary; non-object signals become {}', async () => {
    await assert.rejects(() => store.record(null, 'agent', 'x', { outcome: 'minimal' }), /organization_id/);
    await assert.rejects(() => store.record('o', 'webpage', 'x', { outcome: 'minimal' }), /invalid target_kind/);
    await assert.rejects(() => store.record('o', 'agent', '', { outcome: 'minimal' }), /target_id/);
    await assert.rejects(() => store.record('o', 'agent', 'x', { outcome: 'banned' }), /invalid outcome/);
    assert.strictEqual(await count(), 0);
    const r = await store.record('o', 'agent', 'x', { outcome: 'minimal', signals: ['not', 'an', 'object'], answers: 'nope' });
    assert.deepStrictEqual(r.signals, {});
    assert.deepStrictEqual(r.answers, {});
});

test('getLatest / listHistory: newest first, scoped to org + kind + target', async () => {
    await store.record('orgA', 'automation', 7, { outcome: 'minimal' });
    const newest = await store.record('orgA', 'automation', 7, { outcome: 'transparency' });
    await store.record('orgB', 'automation', 7, { outcome: 'prohibited' });
    await store.record('orgA', 'agent', 7, { outcome: 'high_risk' });
    await store.record('orgA', 'automation', 8, { outcome: 'high_risk' });

    const latest = await store.getLatest('orgA', 'automation', 7);
    assert.strictEqual(latest.id, newest.id);
    assert.strictEqual(await store.getLatest('orgC', 'automation', 7), null, 'another organisation reads nothing');
    await assert.rejects(() => store.getLatest('orgA', 'thing', 7), /invalid target_kind/);

    const history = await store.listHistory('orgA', 'automation', '7', { limit: 5 });
    assert.deepStrictEqual(history.map(h => h.outcome), ['transparency', 'minimal']);
    assert.strictEqual((await store.listHistory('orgA', 'automation', '7', { limit: 1 })).length, 1);
});

test('listForOrg: newest per target, org-scoped, live targets only unless includeRemoved', async () => {
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal' });
    await store.record('orgA', 'automation', 'a1', { outcome: 'transparency' });
    await store.record('orgA', 'automation', 'a-legacy', { outcome: 'minimal' });
    await store.record('orgA', 'automation', 'a-trash', { outcome: 'minimal' });
    await store.record('orgA', 'automation', 'a-gone', { outcome: 'minimal' });
    await store.record('orgA', 'automation', 'a-b', { outcome: 'minimal' });
    await store.record('orgA', 'agent', 'ag-1', { outcome: 'high_risk' });
    await store.record('orgB', 'automation', 'a-b', { outcome: 'minimal' });

    const live = await store.listForOrg('orgA');
    assert.deepStrictEqual(live.map(r => `${r.target_kind}:${r.target_id}:${r.outcome}`), [
        'agent:ag-1:high_risk',
        'automation:a-legacy:minimal',
        'automation:a1:transparency',
    ], 'a trashed, missing or other-org target is not live; the legacy row resolves its org through the owner');
    const all = await store.listForOrg('orgA', { includeRemoved: true });
    assert.deepStrictEqual(all.map(r => r.target_id), ['ag-1', 'a-b', 'a-gone', 'a-legacy', 'a-trash', 'a1']);
});

test('isCurrent: needs an attestation stamp; expiry in the past is not current', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    assert.strictEqual(store.isCurrent(null, now), false);
    assert.strictEqual(store.isCurrent({ attested_at: null, expires_at: null }, now), false);
    assert.strictEqual(store.isCurrent({ attested_at: '2026-01-01T00:00:00Z', expires_at: null }, now), true);
    assert.strictEqual(store.isCurrent({ attested_at: '2026-01-01T00:00:00Z', expires_at: '2026-09-14T12:00:01Z' }, now), true);
    assert.strictEqual(store.isCurrent({ attested_at: '2026-01-01T00:00:00Z', expires_at: '2026-09-14T12:00:00Z' }, now), false);
});

test('stats: attested/expired over the newest row per live target; zero defaults', async () => {
    assert.deepStrictEqual(await store.stats('orgA'), { attested: 0, expired: 0 });
    // a1: expired once, then re-attested — the newest row counts.
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal', expiresAt: '2020-01-01T00:00:00Z' });
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal' });
    await store.record('orgA', 'agent', 'ag-1', { outcome: 'minimal', expiresAt: '2020-01-01T00:00:00Z' });
    await store.record('orgA', 'automation', 'a-legacy', { outcome: 'not_applicable', expiresAt: null });
    await store.record('orgA', 'automation', 'a-trash', { outcome: 'minimal' });
    await store.record('orgB', 'automation', 'a-b', { outcome: 'minimal' });
    assert.deepStrictEqual(await store.stats('orgA'), { attested: 2, expired: 1 });
});

test('listExpiring: newest per live target, expiring within N days (default 30, garbage → 30)', async () => {
    const inDays = (d) => new Date(Date.now() + d * 86400 * 1000).toISOString();
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal', expiresAt: inDays(5) });
    await store.record('orgA', 'agent', 'ag-1', { outcome: 'minimal', expiresAt: inDays(20) });
    await store.record('orgA', 'automation', 'a-legacy', { outcome: 'minimal', expiresAt: null });
    await store.record('orgA', 'automation', 'a-trash', { outcome: 'minimal', expiresAt: inDays(1) });
    await store.record('orgB', 'automation', 'a-b', { outcome: 'minimal', expiresAt: inDays(1) });

    assert.deepStrictEqual((await store.listExpiring('orgA', 7)).map(r => r.target_id), ['a1']);
    assert.deepStrictEqual((await store.listExpiring('orgA', 'lots')).map(r => r.target_id), ['a1', 'ag-1'], 'soonest first');
    // A re-attestation replaces the expiring row.
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal' });
    assert.deepStrictEqual((await store.listExpiring('orgA', 7)).map(r => r.target_id), []);
});

test('constants for the routes', () => {
    assert.deepStrictEqual(store.TARGET_KINDS, ['automation', 'agent']);
    assert.deepStrictEqual(store.OUTCOMES, ['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']);
    assert.strictEqual(store.VALID_MONTHS, 12);
});
