/**
 * aiActAssessmentStore — append-only attestations per automation/agent.
 * Recording db double: the assertions are about the statements (org scoping,
 * DISTINCT ON newest-per-target, the 12-month default expiry) and the pure
 * `isCurrent` rule.
 *
 * Run: cd server && node --test --test-force-exit stores/aiActAssessmentStore.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub } = require('../testUtils/stubRequire');

const rows = [];
let nextId = 1;
const mock = createRecordingDb({
    tables: { compliance_ai_act_assessments: rows },
    onQuery(sql, params) {
        if (/^INSERT INTO compliance_ai_act_assessments/i.test(sql)) {
            const cols = sql.match(/\(([\s\S]*?)\)\s*VALUES/i)[1].split(',').map(s => s.trim());
            const vals = sql.match(/VALUES\s*\(([\s\S]*?)\)\s*RETURNING/i)[1].split(',').map(s => s.trim());
            const row = { id: nextId++, created_at: new Date() };
            cols.forEach((c, i) => {
                const p = vals[i].match(/^\$(\d+)/);
                row[c] = p ? params[Number(p[1]) - 1] : vals[i];
            });
            for (const j of ['signals', 'answers']) if (typeof row[j] === 'string') row[j] = JSON.parse(row[j]);
            rows.push(row);
            return { rows: [{ ...row }], rowCount: 1 };
        }
        return undefined;
    },
});
const restore = installResolveStub({ '../db': mock.db });
const store = require('./aiActAssessmentStore');

let bootDdl = '';
before(async () => {
    await store.initDB();
    bootDdl = mock.calls.exec.map(c => c.sql).join('\n');
});
after(() => restore());
beforeEach(() => { rows.length = 0; nextId = 1; mock.reset(); });

const MONTH_MS_MIN = 28 * 86400 * 1000;

test('boot DDL creates the append-only table and the per-target index', () => {
    assert.match(bootDdl, /CREATE TABLE IF NOT EXISTS compliance_ai_act_assessments/);
    for (const col of ['organization_id TEXT NOT NULL', 'target_kind TEXT NOT NULL', 'target_id TEXT NOT NULL',
        "signals JSONB NOT NULL DEFAULT '{}'::jsonb", "answers JSONB NOT NULL DEFAULT '{}'::jsonb", 'outcome TEXT NOT NULL',
        'attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', 'expires_at TIMESTAMPTZ']) {
        assert.ok(bootDdl.includes(col), col);
    }
    assert.match(bootDdl, /CREATE INDEX IF NOT EXISTS idx_ai_act_assess_target ON compliance_ai_act_assessments\(organization_id, target_kind, target_id, created_at DESC\)/);
    assert.ok(!/UPDATE|DELETE/.test(bootDdl), 'append-only: no mutation of history at boot');
});

test('record: inserts org-scoped with jsonb signals/answers, expiry defaults to +12 months', async () => {
    const out = await store.record('orgA', 'automation', 42, {
        signals: { contains_ai: true, customer_facing: true },
        answers: { art50: { interacts: true, disclosure: true } },
        outcome: 'transparency',
        attestedBy: 'u-1',
    });
    const ins = mock.mutations()[0];
    assert.match(ins.sql, /INSERT INTO compliance_ai_act_assessments/);
    assert.strictEqual(ins.params[0], 'orgA');
    assert.strictEqual(ins.params[1], 'automation');
    assert.strictEqual(ins.params[2], '42', 'target id stored as text');
    assert.match(ins.sql, /\$4::jsonb, \$5::jsonb/);
    assert.deepStrictEqual(JSON.parse(ins.params[3]), { contains_ai: true, customer_facing: true });
    assert.strictEqual(ins.params[5], 'transparency');
    assert.strictEqual(ins.params[6], 'u-1');
    const attested = ins.params[7], expires = ins.params[8];
    assert.ok(expires.getTime() - attested.getTime() >= 12 * MONTH_MS_MIN, 'roughly a year later');
    assert.strictEqual(expires.getUTCMonth(), (attested.getUTCMonth() + 12) % 12);
    assert.strictEqual(out.outcome, 'transparency');
    assert.ok(store.isCurrent(out));
});

test('record: source and evidence from the automation\'s own check; boot adds both columns', async () => {
    assert.match(bootDdl, /ALTER TABLE compliance_ai_act_assessments ADD COLUMN IF NOT EXISTS source TEXT/);
    assert.match(bootDdl, /ALTER TABLE compliance_ai_act_assessments ADD COLUMN IF NOT EXISTS evidence JSONB/);
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal', attestedBy: 'bee', source: 'auto', evidence: { v: 1, questions: { usesAi: { answer: 'yes' } } } });
    const ins = mock.mutations()[0];
    assert.match(ins.sql, /\$10, \$11::jsonb/);
    assert.strictEqual(ins.params[9], 'auto');
    assert.deepStrictEqual(JSON.parse(ins.params[10]), { v: 1, questions: { usesAi: { answer: 'yes' } } });
    // The hub passes neither; an unknown source is not stored.
    await store.record('orgA', 'automation', 'a1', { outcome: 'minimal', source: 'whatever', evidence: ['x'] });
    const hub = mock.mutations()[1];
    assert.strictEqual(hub.params[9], null);
    assert.strictEqual(hub.params[10], null);
});

test('record: explicit null expiry is evergreen; explicit date is kept; garbage rejected', async () => {
    const a = await store.record('orgA', 'agent', 'ag-1', { outcome: 'not_applicable', expiresAt: null });
    assert.strictEqual(a.expires_at, null);
    assert.ok(store.isCurrent(a), 'no expiry = current');
    const b = await store.record('orgA', 'agent', 'ag-1', { outcome: 'minimal', expiresAt: '2030-01-01T00:00:00.000Z' });
    assert.strictEqual(b.expires_at.toISOString(), '2030-01-01T00:00:00.000Z');
    await assert.rejects(() => store.record('orgA', 'agent', 'ag-1', { outcome: 'minimal', expiresAt: 'someday' }), /expires_at/);
});

test('record guards: org, kind, target, outcome vocabulary; non-object signals become {}', async () => {
    await assert.rejects(() => store.record(null, 'agent', 'x', { outcome: 'minimal' }), /organization_id/);
    await assert.rejects(() => store.record('o', 'webpage', 'x', { outcome: 'minimal' }), /invalid target_kind/);
    await assert.rejects(() => store.record('o', 'agent', '', { outcome: 'minimal' }), /target_id/);
    await assert.rejects(() => store.record('o', 'agent', 'x', { outcome: 'banned' }), /invalid outcome/);
    assert.strictEqual(rows.length, 0);
    await store.record('o', 'agent', 'x', { outcome: 'minimal', signals: ['not', 'an', 'object'], answers: 'nope' });
    assert.deepStrictEqual(rows[0].signals, {});
    assert.deepStrictEqual(rows[0].answers, {});
});

test('getLatest / listHistory: newest first, scoped to org + kind + target', async () => {
    await store.getLatest('orgA', 'automation', 7);
    const q = mock.calls.getOne[0];
    assert.match(q.sql, /WHERE organization_id = \$1 AND target_kind = \$2 AND target_id = \$3/);
    assert.match(q.sql, /ORDER BY created_at DESC, id DESC\s+LIMIT 1/);
    assert.deepStrictEqual(q.params, ['orgA', 'automation', '7']);
    await assert.rejects(() => store.getLatest('orgA', 'thing', 7), /invalid target_kind/);

    await store.listHistory('orgA', 'agent', 'ag', { limit: 5 });
    const h = mock.calls.getAll[0];
    assert.match(h.sql, /WHERE organization_id = \$1 AND target_kind = \$2 AND target_id = \$3/);
    assert.deepStrictEqual(h.params, ['orgA', 'agent', 'ag', 5]);
});

test('listForOrg: DISTINCT ON target (kind, id) newest first, org-scoped', async () => {
    await store.listForOrg('orgA');
    const q = mock.calls.getAll[0];
    assert.match(q.sql, /SELECT DISTINCT ON \(target_kind, target_id\)/);
    assert.match(q.sql, /WHERE organization_id = \$1/);
    assert.match(q.sql, /ORDER BY target_kind, target_id, created_at DESC, id DESC/);
    assert.deepStrictEqual(q.params, ['orgA']);
});

test('isCurrent: needs an attestation stamp; expiry in the past is not current', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    assert.strictEqual(store.isCurrent(null, now), false);
    assert.strictEqual(store.isCurrent({ attested_at: null, expires_at: null }, now), false);
    assert.strictEqual(store.isCurrent({ attested_at: '2026-01-01T00:00:00Z', expires_at: null }, now), true);
    assert.strictEqual(store.isCurrent({ attested_at: '2026-01-01T00:00:00Z', expires_at: '2026-09-14T12:00:01Z' }, now), true);
    assert.strictEqual(store.isCurrent({ attested_at: '2026-01-01T00:00:00Z', expires_at: '2026-09-14T12:00:00Z' }, now), false);
});

test('stats: attested/expired over the newest row per target; zero defaults', async () => {
    const s = await store.stats('orgA');
    assert.deepStrictEqual(s, { attested: 0, expired: 0 });
    const q = mock.calls.getOne[0];
    assert.match(q.sql, /DISTINCT ON \(target_kind, target_id\) expires_at/);
    assert.match(q.sql, /WHERE organization_id = \$1/);
    assert.match(q.sql, /expires_at IS NULL OR expires_at > NOW\(\)\)::int AS attested/);
    assert.match(q.sql, /expires_at IS NOT NULL AND expires_at <= NOW\(\)\)::int AS expired/);
    assert.deepStrictEqual(q.params, ['orgA']);
});

test('listExpiring: newest per target, expiring within N days (default 30, garbage → 30)', async () => {
    await store.listExpiring('orgA', 7);
    let q = mock.calls.getAll[0];
    assert.match(q.sql, /DISTINCT ON \(target_kind, target_id\)/);
    assert.match(q.sql, /WHERE organization_id = \$1/);
    assert.match(q.sql, /expires_at IS NOT NULL AND expires_at < NOW\(\) \+ \(\$2 \|\| ' days'\)::interval/);
    assert.deepStrictEqual(q.params, ['orgA', '7']);
    mock.reset();
    await store.listExpiring('orgA', 'lots');
    q = mock.calls.getAll[0];
    assert.deepStrictEqual(q.params, ['orgA', '30']);
});

test('constants for the routes', () => {
    assert.deepStrictEqual(store.TARGET_KINDS, ['automation', 'agent']);
    assert.deepStrictEqual(store.OUTCOMES, ['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']);
    assert.strictEqual(store.VALID_MONTHS, 12);
});
