'use strict';

/**
 * The KB-level query-log routes, over the real router, the real stores and a real Postgres (PGlite):
 * who may call them, what the settings write to the audit, what the list, review and export do.
 *
 * Run: cd server && node --test routes/knowledgeBases/queryLog.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'qlog-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'qlog-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { pg, close: closePg } = usePglitePool();
const h = require('../../testUtils/routeHarness');
const crypto = require('../../core/kb/queryLog/crypto.mts');

const ORG = 'org-ql';           // licensed (enterprise plan)
const ORG_OTHER = 'org-ql-2';   // licensed, another tenant
const ORG_FREE = 'org-ql-free'; // no kb_query_log
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@ql.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const OWNER = mk('u-owner', ORG);
const READER = mk('u-reader', ORG);
const OUTSIDER = mk('u-outsider', ORG_OTHER);
const FREE_OWNER = mk('u-free-owner', ORG_FREE);
const ASKER = mk('u-asker', ORG, { displayName: 'Ada Asker' });

let api;
let kbId;
let freeKbId;
let store;

before(async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 7), sealingEnabled: async () => true });
    const userStore = require('../../stores/userStore');
    await userStore.initDB();
    const enterprise = await userStore.createPlan({ name: 'QL enterprise', tier: 'enterprise', allowed_features: ['knowledge', 'kb_query_log'] });
    const pro = await userStore.createPlan({ name: 'QL free', tier: null, allowed_features: ['knowledge'] });
    for (const [id, plan] of [[ORG, enterprise], [ORG_OTHER, enterprise], [ORG_FREE, pro]]) {
        await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
    }
    for (const u of [OWNER, READER, OUTSIDER, FREE_OWNER, ASKER]) await userStore.createUser({ ...u, passwordHash: 'x' });
    const kbStore = require('../../stores/knowledgeBases');
    kbId = (await kbStore.createKB(OWNER.id, 'Handbook', '', ORG, { isPublished: true })).id;
    freeKbId = (await kbStore.createKB(FREE_OWNER.id, 'Free handbook', '', ORG_FREE, { isPublished: true })).id;
    store = require('../../stores/kb/queryLog/index.mts');
    api = h.serve('/', require('../knowledgeBases'), { user: OWNER });
}, { timeout: 120_000 });

after(async () => {
    crypto._setCryptoDeps(null);
    await api.close();
    await closePg();
});

beforeEach(async () => {
    await pg.exec('DELETE FROM kb_query_log; DELETE FROM access_audit_log');
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false, query_log_retention_days = 90`);
});

const entry = (over = {}) => ({
    searchGroupId: `g-${Math.random()}`, organizationId: ORG, kbId, userId: ASKER.id, channel: 'direct_chat', channelRef: {},
    query: 'how long is the notice period?', chunks: [{ chunkId: 'c1', documentId: 'd1', title: 'Contract', score: 0.9, text: 'Three months.' }],
    retrievalMs: 5, outcome: 'answered', retentionDays: 90, ...over,
});
const seed = async (rows) => {
    // The store only writes while the base logs; the tests seed rows for any state of the setting.
    const was = (await pg.query('SELECT id, query_log_enabled FROM knowledge_bases')).rows;
    await pg.exec('UPDATE knowledge_bases SET query_log_enabled = true');
    try { return await store.insertEntries(rows.map((r) => entry(r))); } finally {
        for (const k of was) await pg.query('UPDATE knowledge_bases SET query_log_enabled = $2 WHERE id = $1', [k.id, k.query_log_enabled]);
    }
};
const audit = async () => (await pg.query('SELECT action, target_type, target_id, changed_by, organization_id, old_values, new_values FROM access_audit_log ORDER BY created_at, id')).rows;
const as = (user) => ({ user });

const ALL_KB_ROUTES = (id, entryId = 'e1') => [
    ['PUT', `/${id}/query-log/settings`, { enabled: true }],
    ['GET', `/${id}/query-log`],
    ['GET', `/${id}/query-log/export.csv`],
    ['GET', `/${id}/query-log/${entryId}`],
    ['PATCH', `/${id}/query-log/${entryId}/review`, { status: 'reviewed' }],
    ['DELETE', `/${id}/query-log`],
];

// ── Who may call ────────────────────────────────────────────────────

test('a reader of the published base gets 404 on every KB route; the manager gets through', async () => {
    await seed([{ id: 'e1' }]);
    for (const [method, url, body] of ALL_KB_ROUTES(kbId)) {
        const res = await api.call(method, url, { user: READER, body });
        assert.equal(res.status, 404, `${method} ${url} as a reader: ${res.status}`);
    }
    for (const [method, url, body] of ALL_KB_ROUTES(kbId)) {
        const res = await api.call(method, url, { ...as(OWNER), body });
        assert.equal(res.status, 200, `${method} ${url} as the manager: ${res.status} ${res.text.slice(0, 120)}`);
    }
});

test('a member of another organisation gets 404, and an unknown base too', async () => {
    for (const [method, url, body] of ALL_KB_ROUTES(kbId)) {
        assert.equal((await api.call(method, url, { user: OUTSIDER, body })).status, 404, `${method} ${url}`);
    }
    assert.equal((await api.call('GET', '/11111111-1111-4111-8111-111111111111/query-log', as(OWNER))).status, 404);
});

test('without the kb_query_log licence the KB routes answer with the licence error, not the data', async () => {
    const res = await api.call('GET', `/${freeKbId}/query-log`, as(FREE_OWNER));
    assert.equal(res.status, 403);
    assert.ok(res.body.error || res.body.code, 'a structured licence refusal');
    const put = await api.call('PUT', `/${freeKbId}/query-log/settings`, { user: FREE_OWNER, body: { enabled: true } });
    assert.equal(put.status, 403);
    assert.equal((await pg.query(`SELECT query_log_enabled FROM knowledge_bases WHERE id = $1`, [freeKbId])).rows[0].query_log_enabled, false);
});

test('after the licence ran out a manager can still switch off and purge (DELETE), but not enable', async () => {
    await seed([{ id: 'f1', kbId: freeKbId, organizationId: ORG_FREE }]);
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true WHERE id = '${freeKbId}'`);
    const res = await api.call('DELETE', `/${freeKbId}/query-log`, as(FREE_OWNER));
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.equal(res.body.enabled, false);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM kb_query_log WHERE kb_id = $1', [freeKbId])).rows[0].n, 0);
    assert.ok((await audit()).some((r) => r.action === 'kb.query_log.purged' && r.target_id === freeKbId));
    assert.equal((await api.call('DELETE', `/${freeKbId}/query-log`, as(READER))).status, 404, 'still manager-gated');
});

test('logging cannot be enabled on a knowledge base without an organisation', async () => {
    const kbStore = require('../../stores/knowledgeBases');
    const personal = (await kbStore.createKB(OWNER.id, 'Personal', '', null, {})).id;
    const res = await api.call('PUT', `/${personal}/query-log/settings`, { user: OWNER, body: { enabled: true } });
    assert.equal(res.status, 400);
    assert.equal((await pg.query('SELECT query_log_enabled FROM knowledge_bases WHERE id = $1', [personal])).rows[0].query_log_enabled, false);
});

test('a base moved to another organisation loses its log, audited as organization_changed', async () => {
    const kbStore = require('../../stores/knowledgeBases');
    const moving = (await kbStore.createKB(OWNER.id, 'Moving', '', ORG, {})).id;
    await seed([{ id: 'mv1', kbId: moving }]);
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true WHERE id = '${moving}'`);
    await require('../../stores/projectStore').initDB();
    await kbStore.updateKB(moving, { organizationId: ORG_OTHER });
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM kb_query_log WHERE kb_id = $1', [moving])).rows[0].n, 0);
    assert.equal((await pg.query('SELECT query_log_enabled FROM knowledge_bases WHERE id = $1', [moving])).rows[0].query_log_enabled, false);
    const row = (await audit()).find((r) => r.action === 'kb.query_log.purged' && r.target_id === moving);
    assert.ok(row);
    assert.equal(JSON.parse(row.new_values).reason, 'organization_changed');
});

test('no session at all is a 401', async () => {
    assert.equal((await api.call('GET', `/${kbId}/query-log`, { user: null })).status, 401);
});

// ── Settings and audit ──────────────────────────────────────────────

test('enable, change the term and disable each write an audit row with old and new values', async () => {
    let res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: true, retentionDays: 30 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.retentionDays, 30);
    assert.equal(res.body.changedBy, OWNER.id);

    res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: true, retentionDays: 180 } });
    assert.equal(res.status, 200);
    res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: false } });
    assert.equal(res.status, 200);

    const rows = await audit();
    // enable (with a new term: two rows), a term change, a disable
    assert.deepEqual(rows.map((r) => r.action).sort(), [
        'kb.query_log.disabled', 'kb.query_log.enabled', 'kb.query_log.retention_changed', 'kb.query_log.retention_changed',
    ]);
    const enabled = rows.find((r) => r.action === 'kb.query_log.enabled');
    assert.equal(enabled.target_type, 'knowledge_base');
    assert.equal(enabled.target_id, kbId);
    assert.equal(enabled.changed_by, OWNER.id);
    assert.equal(enabled.organization_id, ORG);
    assert.deepEqual(JSON.parse(enabled.old_values), { enabled: false, retentionDays: 90 });
    assert.deepEqual(JSON.parse(enabled.new_values), { enabled: true, retentionDays: 30 });
});

test('a settings call that changes nothing writes no audit row', async () => {
    const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: false } });
    assert.equal(res.status, 200);
    assert.deepEqual(await audit(), []);
});

test('an audit write that fails refuses the change: nothing is switched on', async () => {
    await pg.exec('ALTER TABLE access_audit_log RENAME TO access_audit_log_off');
    try {
        const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: true } });
        assert.equal(res.status, 503);
        assert.equal(res.body.code, 'audit_unavailable');
    } finally {
        await pg.exec('ALTER TABLE access_audit_log_off RENAME TO access_audit_log');
    }
    assert.equal((await pg.query(`SELECT query_log_enabled FROM knowledge_bases WHERE id = $1`, [kbId])).rows[0].query_log_enabled, false);
});

test('disable with deleteExisting removes the rows of that base only and audits the purge', async () => {
    await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: true } });
    const otherKb = (await require('../../stores/knowledgeBases').createKB(OWNER.id, 'Other', '', ORG, {})).id;
    await seed([{ id: 'a1' }, { id: 'a2' }, { id: 'o1', kbId: otherKb, searchGroupId: 'g-o' }]);
    const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: false, deleteExisting: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
    const left = (await pg.query('SELECT id FROM kb_query_log')).rows.map((r) => r.id);
    assert.deepEqual(left, ['o1']);
    assert.ok((await audit()).some((r) => r.action === 'kb.query_log.purged' && r.target_id === kbId));
});

test('disable without deleteExisting keeps the rows until the term ends', async () => {
    await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: true } });
    await seed([{ id: 'k1' }]);
    const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: false } });
    assert.equal(res.body.deleted, 0);
    assert.equal((await pg.query('SELECT id FROM kb_query_log')).rows.length, 1);
});

test('a shorter term moves expires_at of the rows that exist', async () => {
    await seed([{ id: 't1', createdAt: new Date(Date.now() - 40 * 86_400_000) }]);
    await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: true, retentionDays: 30 } });
    const { rows } = await pg.query(`SELECT expires_at < now() AS gone FROM kb_query_log WHERE id = 't1'`);
    assert.equal(rows[0].gone, true);
});

test('the settings body is checked: unknown keys, a term outside the list, a missing enabled', async () => {
    for (const body of [{ enabled: true, retentionDays: 45 }, { enabled: 'yes' }, { retentionDays: 30 }, { enabled: true, extra: 1 }]) {
        const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
});

// ── List, detail, review ────────────────────────────────────────────

test('the list filters on period, user, channel, outcome, status and text, and names the user', async () => {
    await seed([
        { id: 'l1', createdAt: '2026-11-01T10:00:00Z', query: 'holiday allowance', outcome: 'answered' },
        { id: 'l2', createdAt: '2026-11-02T10:00:00Z', query: 'pension scheme', channel: 'agent_chat', outcome: 'no_results', chunks: [] },
        { id: 'l3', createdAt: '2026-11-03T10:00:00Z', query: 'expenses policy', userId: READER.id, outcome: 'error', errorCode: 'x' },
    ]);
    const list = async (qs) => (await api.call('GET', `/${kbId}/query-log${qs}`, as(OWNER))).body;
    const all = await list('');
    assert.equal(all.total, 3);
    assert.equal(all.rows[0].query !== undefined, true);
    assert.equal(all.rows.find((r) => r.id === 'l1').userName, 'Ada Asker');
    assert.deepEqual((await list('?channel=agent_chat')).rows.map((r) => r.id), ['l2']);
    assert.deepEqual((await list('?outcome=error')).rows.map((r) => r.id), ['l3']);
    assert.deepEqual((await list(`?userId=${READER.id}`)).rows.map((r) => r.id), ['l3']);
    assert.deepEqual((await list('?from=2026-11-02T00:00:00Z&to=2026-11-02T23:59:59Z')).rows.map((r) => r.id), ['l2']);
    assert.deepEqual((await list('?q=pension')).rows.map((r) => r.id), ['l2']);
    assert.equal((await list('?status=reviewed')).total, 0);
    assert.equal((await list('?limit=1&offset=1')).rows.length, 1);
    assert.equal((await api.call('GET', `/${kbId}/query-log?channel=nope`, as(OWNER))).status, 400);
    assert.equal((await api.call('GET', `/${kbId}/query-log?limit=9999`, as(OWNER))).status, 400);
});

test('the list never shows another base or another organisation', async () => {
    const otherKb = (await require('../../stores/knowledgeBases').createKB(OWNER.id, 'Else', '', ORG, {})).id;
    await seed([{ id: 'm1' }, { id: 'm2', kbId: otherKb, searchGroupId: 'g2', query: 'secret elsewhere' }]);
    const res = await api.call('GET', `/${kbId}/query-log`, as(OWNER));
    assert.deepEqual(res.body.rows.map((r) => r.id), ['m1']);
    assert.equal((await api.call('GET', `/${kbId}/query-log/m2`, as(OWNER))).status, 404);
});

test('the review sets status and note, and refuses a bad status or an over-long note', async () => {
    await seed([{ id: 'r1' }]);
    const ok = await api.call('PATCH', `/${kbId}/query-log/r1/review`, { ...as(OWNER), body: { status: 'needs_addition', note: 'add the 2026 policy' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.reviewStatus, 'needs_addition');
    assert.equal(ok.body.reviewNote, 'add the 2026 policy');
    assert.equal(ok.body.reviewedBy, OWNER.id);
    const read = await api.call('GET', `/${kbId}/query-log/r1`, as(OWNER));
    assert.equal(read.body.reviewStatus, 'needs_addition');
    assert.equal(read.body.query, 'how long is the notice period?');
    assert.equal((await api.call('PATCH', `/${kbId}/query-log/r1/review`, { ...as(OWNER), body: { status: 'done' } })).status, 400);
    assert.equal((await api.call('PATCH', `/${kbId}/query-log/r1/review`, { ...as(OWNER), body: { status: 'reviewed', note: 'x'.repeat(4001) } })).status, 400);
    assert.equal((await api.call('PATCH', `/${kbId}/query-log/nope/review`, { ...as(OWNER), body: { status: 'reviewed' } })).status, 404);
    // 4000 characters is the limit and is accepted
    assert.equal((await api.call('PATCH', `/${kbId}/query-log/r1/review`, { ...as(OWNER), body: { status: 'reviewed', note: 'x'.repeat(4000) } })).status, 200);
});

// ── CSV export ──────────────────────────────────────────────────────

test('the CSV has the columns, escapes formulas, respects filters and is audited first', async () => {
    await seed([
        { id: 'c1', query: '=HYPERLINK("http://evil.test","x")', channel: 'agent_chat' },
        { id: 'c2', query: '+1 normal, with comma', channel: 'direct_chat' },
        { id: 'c3', query: 'filtered out', channel: 'notebook' },
    ]);
    const res = await api.call('GET', `/${kbId}/query-log/export.csv?channel=agent_chat`, as(OWNER));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'createdAt,user,channel,outcome,reviewStatus,query,answer,chunkCount,topScore,model,retrievalMs,answerMs,errorCode,reviewNote,reviewedAt');
    assert.equal(lines.length, 2, 'only the agent_chat row');
    assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`), lines[1]);
    assert.ok(!lines[1].includes(',=HYPERLINK'), 'no bare formula cell');

    const both = await api.call('GET', `/${kbId}/query-log/export.csv?channel=direct_chat`, as(OWNER));
    assert.ok(both.text.includes(`"'+1 normal, with comma"`));

    const exported = (await audit()).filter((r) => r.action === 'kb.query_log.exported');
    assert.equal(exported.length, 2);
    assert.ok(exported.every((r) => r.target_id === kbId && r.changed_by === OWNER.id));
    const first = exported.map((r) => JSON.parse(r.new_values)).find((v) => v.filters.channel === 'agent_chat');
    assert.ok(first, 'the filters of the export are in the audit row');
    assert.equal(first.text, false);
});

test('an export whose audit write fails sends no file', async () => {
    await seed([{ id: 'x1' }]);
    await pg.exec('ALTER TABLE access_audit_log RENAME TO access_audit_log_off');
    try {
        const res = await api.call('GET', `/${kbId}/query-log/export.csv`, as(OWNER));
        assert.equal(res.status, 503);
        assert.ok(!res.text.includes('notice period'));
    } finally {
        await pg.exec('ALTER TABLE access_audit_log_off RENAME TO access_audit_log');
    }
});

test('the export is rate limited per user, like the compliance export', () => {
    assert.deepEqual(h.limitersOn(require('./queryLog'), 'get', '/:id/query-log/export.csv'), ['kb-query-log-kb-export']);
});

// ── Notice ──────────────────────────────────────────────────────────

test('the notice names only logging bases the caller can read, and only with the licence', async () => {
    const kbStore = require('../../stores/knowledgeBases');
    const draft = (await kbStore.createKB(OWNER.id, 'Draft logging', '', ORG, { isPublished: false })).id;
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true WHERE id IN ('${kbId}', '${draft}', '${freeKbId}')`);
    const notice = async (user, ids) => (await api.call('GET', `/query-log/notice?kbIds=${ids.join(',')}`, as(user)));

    let res = await notice(READER, [kbId, draft, freeKbId]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { active: true, kbs: [{ id: kbId, name: 'Handbook' }] }, 'a reader sees the published base only');

    res = await notice(OWNER, [kbId, draft]);
    assert.deepEqual(res.body.kbs.map((k) => k.id).sort(), [draft, kbId].sort());

    res = await notice(READER, [draft]);
    assert.deepEqual(res.body, { active: false, kbs: [] }, 'a draft the reader cannot open is not even hinted at');

    res = await notice(FREE_OWNER, [freeKbId]);
    assert.deepEqual(res.body, { active: false, kbs: [] }, 'logging is set on but the licence is missing: nothing is logged, nothing announced');

    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false WHERE id = '${kbId}'`);
    res = await notice(READER, [kbId]);
    assert.equal(res.body.active, false);
    assert.equal((await api.call('GET', '/query-log/notice', as(READER))).status, 400);
});
