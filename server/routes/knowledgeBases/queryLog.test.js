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
const { ATTESTATION, enableBody } = require('../../testUtils/kbQueryLogAttestation');

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
    await pg.exec('DELETE FROM kb_query_log; DELETE FROM kb_query_log_ack; DELETE FROM access_audit_log');
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false, query_log_retention_days = 90, query_log_show_names = false,
        query_log_ai_act_high_risk = false, query_log_attestation = NULL, query_log_attested_by = NULL, query_log_attested_at = NULL, query_log_changed_at = NULL`);
});

const entry = (over = {}) => ({
    searchGroupId: `g-${Math.random()}`, organizationId: ORG, kbId, userId: ASKER.id, channel: 'direct_chat', channelRef: {},
    query: 'how long is the notice period?', chunks: [{ chunkId: 'c1', documentId: 'd1', title: 'Contract', score: 0.9, text: 'Three months.' }],
    retrievalMs: 5, outcome: 'answered', retentionDays: 90, ...over,
});
const seed = async (rows) => {
    // The store only writes while the base logs; the tests seed rows for any state of the setting.
    const was = (await pg.query('SELECT id, query_log_enabled FROM knowledge_bases')).rows;
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb)`);
    try { return await store.insertEntries(rows.map((r) => entry(r))); } finally {
        for (const k of was) await pg.query('UPDATE knowledge_bases SET query_log_enabled = $2 WHERE id = $1', [k.id, k.query_log_enabled]);
    }
};
const audit = async () => (await pg.query('SELECT action, target_type, target_id, changed_by, organization_id, old_values, new_values FROM access_audit_log ORDER BY created_at, id')).rows;
const as = (user) => ({ user });

const ALL_KB_ROUTES = (id, entryId = 'e1') => [
    ['PUT', `/${id}/query-log/settings`, enableBody()],
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
    const put = await api.call('PUT', `/${freeKbId}/query-log/settings`, { user: FREE_OWNER, body: enableBody() });
    assert.equal(put.status, 403);
    assert.equal((await pg.query(`SELECT query_log_enabled FROM knowledge_bases WHERE id = $1`, [freeKbId])).rows[0].query_log_enabled, false);
});

test('after the licence ran out a manager can still switch off and purge (DELETE), but not enable', async () => {
    await seed([{ id: 'f1', kbId: freeKbId, organizationId: ORG_FREE }]);
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id = '${freeKbId}'`);
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
    const res = await api.call('PUT', `/${personal}/query-log/settings`, { user: OWNER, body: enableBody() });
    assert.equal(res.status, 400);
    assert.equal((await pg.query('SELECT query_log_enabled FROM knowledge_bases WHERE id = $1', [personal])).rows[0].query_log_enabled, false);
});

test('a base moved to another organisation loses its log, audited as organization_changed', async () => {
    const kbStore = require('../../stores/knowledgeBases');
    const moving = (await kbStore.createKB(OWNER.id, 'Moving', '', ORG, {})).id;
    await seed([{ id: 'mv1', kbId: moving }]);
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id = '${moving}'`);
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
    let res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: enableBody({ retentionDays: 30 }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.retentionDays, 30);
    assert.equal(res.body.changedBy, OWNER.id);

    res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: enableBody({ retentionDays: 180 }) });
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
    assert.deepEqual(JSON.parse(enabled.old_values), { enabled: false, retentionDays: 90, showNames: false, aiActHighRisk: false });
    assert.deepEqual(JSON.parse(enabled.new_values), { enabled: true, retentionDays: 30, showNames: false, aiActHighRisk: false, attestation: { ...ATTESTATION, dpiaId: null } });
});

test('a settings call that changes nothing writes no audit row', async () => {
    const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: false } });
    assert.equal(res.status, 200);
    assert.deepEqual(await audit(), []);
});

test('an audit write that fails refuses the change: nothing is switched on', async () => {
    await pg.exec('ALTER TABLE access_audit_log RENAME TO access_audit_log_off');
    try {
        const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: enableBody() });
        assert.equal(res.status, 503);
        assert.equal(res.body.code, 'audit_unavailable');
    } finally {
        await pg.exec('ALTER TABLE access_audit_log_off RENAME TO access_audit_log');
    }
    assert.equal((await pg.query(`SELECT query_log_enabled FROM knowledge_bases WHERE id = $1`, [kbId])).rows[0].query_log_enabled, false);
});

test('disable with deleteExisting removes the rows of that base only and audits the purge', async () => {
    await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: enableBody() });
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
    await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: enableBody() });
    await seed([{ id: 'k1' }]);
    const res = await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: { enabled: false } });
    assert.equal(res.body.deleted, 0);
    assert.equal((await pg.query('SELECT id FROM kb_query_log')).rows.length, 1);
});

test('a shorter term moves expires_at of the rows that exist', async () => {
    await seed([{ id: 't1', createdAt: new Date(Date.now() - 40 * 86_400_000) }]);
    await api.call('PUT', `/${kbId}/query-log/settings`, { ...as(OWNER), body: enableBody({ retentionDays: 30 }) });
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
    await pg.exec(`UPDATE knowledge_bases SET query_log_show_names = true WHERE id = '${kbId}'`);
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
    assert.equal(lines[0], 'createdAt,asker,channel,outcome,reviewStatus,query,answer,chunkCount,topScore,model,retrievalMs,answerMs,errorCode,reviewNote,reviewedAt');
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

test('every page of the list is recorded in the access audit first, and the list is rate limited per user', async () => {
    await seed([{ id: 'p1' }, { id: 'p2', searchGroupId: 'g-p2' }]);
    const one = await api.call('GET', `/${kbId}/query-log?limit=1`, as(OWNER));
    const two = await api.call('GET', `/${kbId}/query-log?limit=1&offset=1&q=notice`, as(OWNER));
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    const reads = (await audit()).filter((r) => r.action === 'kb.query_log.content_viewed');
    assert.equal(reads.length, 2);
    assert.equal(reads[0].target_id, kbId);
    assert.equal(reads[0].changed_by, OWNER.id);
    assert.equal(reads[0].organization_id, ORG);
    const payload = typeof reads[1].new_values === 'string' ? JSON.parse(reads[1].new_values) : reads[1].new_values;
    assert.deepEqual({ limit: payload.limit, offset: payload.offset, text: payload.text }, { limit: 1, offset: 1, text: true });
    assert.ok(!JSON.stringify(reads).includes('notice period'), 'no text of the log in the audit');
    assert.deepEqual(h.limitersOn(require('./queryLog'), 'get', '/:id/query-log'), ['kb-query-log-kb-read']);
});

test('a list page whose audit write fails shows nothing', async () => {
    await seed([{ id: 'p3' }]);
    await pg.exec('ALTER TABLE access_audit_log RENAME TO access_audit_log_off');
    try {
        const res = await api.call('GET', `/${kbId}/query-log`, as(OWNER));
        assert.equal(res.status, 503);
        assert.ok(!res.text.includes('notice period'));
    } finally {
        await pg.exec('ALTER TABLE access_audit_log_off RENAME TO access_audit_log');
    }
});

// ── Notice ──────────────────────────────────────────────────────────

test('the notice names only logging bases the caller can read, and only with the licence', async () => {
    const kbStore = require('../../stores/knowledgeBases');
    const draft = (await kbStore.createKB(OWNER.id, 'Draft logging', '', ORG, { isPublished: false })).id;
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id IN ('${kbId}', '${draft}', '${freeKbId}')`);
    const notice = async (user, ids) => (await api.call('GET', `/query-log/notice?kbIds=${ids.join(',')}`, as(user)));

    let res = await notice(READER, [kbId, draft, freeKbId]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { active: true, kbs: [{ id: kbId, name: 'Handbook', acknowledged: false, retentionDays: 90, showNames: false }] }, 'a reader sees the published base only');

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

// ── Round 2: attestation, high-risk flag, pseudonyms, acknowledgement ──

const put = (body, user = OWNER, id = kbId) => api.call('PUT', `/${id}/query-log/settings`, { user, body });
const enabledNow = async (id = kbId) => (await pg.query('SELECT query_log_enabled FROM knowledge_bases WHERE id = $1', [id])).rows[0].query_log_enabled;

test('enabling without an attestation, or with an invalid one, is a 400 naming the missing fields; nothing changes', async () => {
    let res = await put({ enabled: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'kb_query_log_attestation_required');
    assert.deepEqual(res.body.details.missing, ['attestation']);

    res = await put({ enabled: true, attestation: { purpose: 'employee_review', dpia: 'done', worksCouncil: 'pending' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.details.missing.sort(), ['dpiaId', 'privacyNoticeUpdated', 'purpose', 'worksCouncil']);

    res = await put({ enabled: true, attestation: { ...ATTESTATION, worksCouncil: 'not_applicable', worksCouncilReason: 'because' } });
    assert.deepEqual(res.body.details.missing, ['worksCouncilReason']);
    res = await put({ enabled: true, attestation: { ...ATTESTATION, privacyNoticeUpdated: false } });
    assert.deepEqual(res.body.details.missing, ['privacyNoticeUpdated']);

    assert.equal(await enabledNow(), false);
    assert.deepEqual(await audit(), []);
});

test('a valid attestation is stored with who and when, returned by GET settings, audited and put into the evidence', async () => {
    const res = await put(enableBody({ retentionDays: 180 }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.attestation, { ...ATTESTATION, dpiaId: null });
    assert.equal(res.body.attestedBy, OWNER.id);
    assert.ok(res.body.attestedAt);
    assert.equal(res.body.showNames, false);

    const got = await api.call('GET', `/${kbId}/query-log/settings`, as(OWNER));
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.attestation, { ...ATTESTATION, dpiaId: null });
    assert.equal(got.body.acknowledgedUsers, 0);
    assert.equal((await api.call('GET', `/${kbId}/query-log/settings`, as(READER))).status, 404);

    const rows = await audit();
    const enabled = rows.find((r) => r.action === 'kb.query_log.enabled');
    assert.deepEqual(JSON.parse(enabled.new_values).attestation, { ...ATTESTATION, dpiaId: null });
    const ev = (await pg.query(`SELECT payload FROM compliance_evidence WHERE check_id = 'GDPR-Art5-kb-query-log' AND subject_id = $1`, [kbId])).rows;
    const p = typeof ev[0].payload === 'string' ? JSON.parse(ev[0].payload) : ev[0].payload;
    assert.equal(p.attDpia, 'not_required');
    assert.equal(p.attWorksCouncil, 'not_applicable');
    assert.equal(p.attPrivacyNoticeUpdated, true);
});

test('dpia done needs a DPIA of THIS organisation; one of another organisation is refused', async () => {
    const dpiaStore = require('../../stores/dpiaStore');
    const mine = await dpiaStore.upsertAssessment(ORG, 'agent-ql', { approved_by: OWNER.id });
    const foreign = await dpiaStore.upsertAssessment(ORG_OTHER, 'agent-ql-other', { approved_by: OUTSIDER.id });
    const att = (dpiaId) => ({ ...ATTESTATION, dpia: 'done', dpiaId });

    let res = await put({ enabled: true, attestation: att(String(foreign.id)) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.details.missing, ['dpiaId']);
    res = await put({ enabled: true, attestation: att('999999') });
    assert.equal(res.status, 400);
    res = await put({ enabled: true, attestation: att(undefined) });
    assert.equal(res.status, 400);
    assert.equal(await enabledNow(), false);

    res = await put({ enabled: true, attestation: att(String(mine.id)) });
    assert.equal(res.status, 200);
    assert.equal(res.body.attestation.dpiaId, String(mine.id));
});

test('the high-risk flag needs a term of 180 days or more and an attestation; 30 and 90 are refused, 180 is accepted', async () => {
    for (const retentionDays of [30, 90]) {
        const res = await put(enableBody({ aiActHighRisk: true, retentionDays }));
        assert.equal(res.status, 400, String(retentionDays));
        assert.equal(res.body.code, 'kb_query_log_retention_too_short');
    }
    assert.equal(await enabledNow(), false);
    assert.equal((await put({ enabled: false, aiActHighRisk: true, retentionDays: 180 })).body.code, 'kb_query_log_attestation_required', 'no attestation on file');

    let res = await put(enableBody({ aiActHighRisk: true, retentionDays: 180 }));
    assert.equal(res.status, 200);
    assert.equal(res.body.aiActHighRisk, true);
    // once flagged, a shorter term is refused
    res = await put({ enabled: true, retentionDays: 90 });
    assert.equal(res.body.code, 'kb_query_log_retention_too_short');
    assert.equal((await put({ enabled: true, retentionDays: 365 })).status, 200);
    assert.ok((await audit()).some((r) => r.action === 'kb.query_log.high_risk_changed'));
});

test('names_changed is audited; showing names needs an attestation on file', async () => {
    assert.equal((await put({ enabled: false, showNames: true })).body.code, 'kb_query_log_attestation_required');
    const res = await put(enableBody({ showNames: true }));
    assert.equal(res.status, 200);
    assert.equal(res.body.showNames, true);
    assert.ok((await audit()).some((r) => r.action === 'kb.query_log.names_changed'));
});

test('names off: list, entry, review and CSV carry a stable pseudonym and no user id or name; on: names', async () => {
    await seed([
        { id: 'p1', userId: ASKER.id, query: 'q one' },
        { id: 'p2', searchGroupId: 'g2', userId: READER.id, query: 'q two' },
        { id: 'p3', searchGroupId: 'g3', userId: ASKER.id, query: 'q three' },
        { id: 'p4', searchGroupId: 'g4', userId: null, query: 'anonymous one', channel: 'api_search' },
    ]);
    const list = async (qs = '') => (await api.call('GET', `/${kbId}/query-log${qs}`, as(OWNER))).body;
    const all = await list();
    assert.equal(all.rows.length, 4);
    for (const r of all.rows) {
        assert.equal('userId' in r, false);
        assert.equal('userName' in r, false);
    }
    const byId = Object.fromEntries(all.rows.map((r) => [r.id, r]));
    assert.match(byId.p1.askerPseudonym, /^Member · [A-Z2-9]{4}$/);
    assert.equal(byId.p1.askerPseudonym, byId.p3.askerPseudonym, 'stable per person');
    assert.equal(byId.p1.askerPseudonymId, byId.p3.askerPseudonymId);
    assert.notEqual(byId.p1.askerPseudonymId, byId.p2.askerPseudonymId);
    assert.equal(byId.p4.askerPseudonym, null);
    assert.equal(JSON.stringify(all).includes('Ada Asker'), false);
    assert.equal(JSON.stringify(all).includes(ASKER.id), false);

    // the person filter takes the pseudonym id; a real user id finds nothing
    assert.deepEqual((await list(`?userId=${byId.p1.askerPseudonymId}`)).rows.map((r) => r.id).sort(), ['p1', 'p3']);
    assert.equal((await list(`?userId=${ASKER.id}`)).total, 0);
    assert.equal((await list('?userId=0000000000000000')).total, 0);

    const one = (await api.call('GET', `/${kbId}/query-log/p1`, as(OWNER))).body;
    assert.equal('userId' in one, false);
    assert.equal(one.askerPseudonym, byId.p1.askerPseudonym);
    const reviewed = (await api.call('PATCH', `/${kbId}/query-log/p1/review`, { ...as(OWNER), body: { status: 'reviewed' } })).body;
    assert.equal('userId' in reviewed, false);

    const csv = (await api.call('GET', `/${kbId}/query-log/export.csv`, as(OWNER))).text;
    assert.ok(csv.includes(byId.p1.askerPseudonym));
    assert.equal(csv.includes('Ada Asker') || csv.includes(ASKER.id), false);
    const csvFiltered = (await api.call('GET', `/${kbId}/query-log/export.csv?userId=${byId.p2.askerPseudonymId}`, as(OWNER))).text;
    assert.ok(csvFiltered.includes('q two') && !csvFiltered.includes('q one'));

    await pg.exec(`UPDATE knowledge_bases SET query_log_show_names = true WHERE id = '${kbId}'`);
    const named = await list();
    assert.equal(named.rows.find((r) => r.id === 'p1').userId, ASKER.id);
    assert.equal(named.rows.find((r) => r.id === 'p1').userName, 'Ada Asker');
    assert.equal((await list(`?userId=${ASKER.id}`)).total, 2);
    assert.ok((await api.call('GET', `/${kbId}/query-log/export.csv`, as(OWNER))).text.includes('Ada Asker'));
});

test('acknowledge: records for readable logging bases only; others (unreadable, not logging, other organisation, unknown) are ignored silently', async () => {
    const kbStore = require('../../stores/knowledgeBases');
    const draft = (await kbStore.createKB(OWNER.id, 'Draft ack', '', ORG, { isPublished: false })).id;
    const quiet = (await kbStore.createKB(OWNER.id, 'Quiet', '', ORG, { isPublished: true })).id;
    const foreign = (await kbStore.createKB(OUTSIDER.id, 'Foreign', '', ORG_OTHER, { isPublished: true })).id;
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id IN ('${kbId}', '${draft}', '${foreign}')`);
    const ack = (user, ids) => api.call('POST', '/query-log/acknowledge', { user, body: { kbIds: ids } });
    const rowsOf = async () => (await pg.query('SELECT user_id, kb_id FROM kb_query_log_ack ORDER BY kb_id')).rows;

    const res = await ack(READER, [kbId, draft, quiet, foreign, '11111111-1111-4111-8111-111111111111', 'junk']);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { active: true, kbs: [{ id: kbId, name: 'Handbook', acknowledged: true, retentionDays: 90, showNames: false }] });
    assert.deepEqual(await rowsOf(), [{ user_id: READER.id, kb_id: kbId }]);

    const none = await ack(READER, [draft, quiet, foreign]);
    assert.deepEqual(none.body, { active: false, kbs: [] });
    assert.equal((await rowsOf()).length, 1);

    assert.equal((await ack(READER, [])).status, 400);
    assert.equal((await api.call('POST', '/query-log/acknowledge', { user: null, body: { kbIds: [kbId] } })).status, 401);

    const notice = await api.call('GET', `/query-log/notice?kbIds=${kbId}`, as(READER));
    assert.equal(notice.body.kbs[0].acknowledged, true);
    const other = await api.call('GET', `/query-log/notice?kbIds=${kbId}`, as(ASKER));
    assert.equal(other.body.kbs[0].acknowledged, false, 'acknowledged per person');

    // any settings change asks everyone again
    await put(enableBody({ retentionDays: 365 }));
    const after = await api.call('GET', `/query-log/notice?kbIds=${kbId}`, as(READER));
    assert.equal(after.body.kbs[0].acknowledged, false);
    assert.equal((await api.call('GET', `/${kbId}/query-log/settings`, as(OWNER))).body.acknowledgedUsers, 0);
});

test('GET /query-log/dpias: managers of the organisation get their own organisation\'s DPIAs only; others get a 404', async () => {
    const dpiaStore = require('../../stores/dpiaStore');
    const mine = await dpiaStore.upsertAssessment(ORG, 'agent-dpias', { approved_by: OWNER.id });
    await dpiaStore.upsertAssessment(ORG_OTHER, 'agent-theirs', { approved_by: OUTSIDER.id });

    const ok = await api.call('GET', '/query-log/dpias', as(OWNER));
    assert.equal(ok.status, 200);
    const ids = ok.body.dpias.map((d) => d.id);
    assert.ok(ids.includes(String(mine.id)));
    assert.ok(ok.body.dpias.every((d) => Object.keys(d).sort().join() === 'id,status,title'));
    assert.ok(!JSON.stringify(ok.body).includes('agent-theirs'), 'no other organisation');

    assert.equal((await api.call('GET', '/query-log/dpias', as(READER))).status, 404, 'a reader who manages nothing');
    assert.equal((await api.call('GET', '/query-log/dpias', as(FREE_OWNER))).status, 403, 'licence');
    assert.equal((await api.call('GET', '/query-log/dpias', { user: null })).status, 401);
    const theirs = (await api.call('GET', '/query-log/dpias', as(OUTSIDER))).body.dpias;
    assert.ok(!theirs.some((d) => d.id === String(mine.id)));
});
