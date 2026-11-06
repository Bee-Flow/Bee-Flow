'use strict';

/**
 * The compliance side of the KB query log, over the real router, the real stores and a real
 * Postgres (PGlite): the overview and the entries carry no text, the text opens only behind an
 * open data-subject request of the same organisation (and only after its audit row exists), and
 * erasure removes one person's rows in one organisation. None of it needs the kb_query_log licence.
 *
 * Run: cd server && node --test routes/compliance/kbQueryLog.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'qlc-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'qlc-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { pg, close: closePg } = usePglitePool();
const h = require('../../testUtils/routeHarness');
const crypto = require('../../core/kb/queryLog/crypto.mts');

const ORG = 'org-qc';
const ORG_OTHER = 'org-qc-2';
const ORG_FREE = 'org-qc-free'; // no kb_query_log licence
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@qc.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const ADMIN = mk('qc-admin', ORG, { orgRole: 'org_admin' });
const MEMBER = mk('qc-member', ORG);
const SUBJECT = mk('qc-subject', ORG, { displayName: 'Sam Subject' });
const BYSTANDER = mk('qc-bystander', ORG);
const ADMIN_OTHER = mk('qc-admin-2', ORG_OTHER, { orgRole: 'org_admin' });
const SUBJECT_OTHER = mk('qc-subject-2', ORG_OTHER);
const ADMIN_FREE = mk('qc-admin-free', ORG_FREE, { orgRole: 'org_admin' });

let api;
let store;
let kbId;
let kbIdOther;
let kbIdFree;
let openRequest;
let closedRequest;
let otherOrgRequest;
let bystanderRequest;

before(async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 5), sealingEnabled: async () => true });
    const userStore = require('../../stores/userStore');
    await userStore.initDB();
    const enterprise = await userStore.createPlan({ name: 'QC enterprise', tier: 'enterprise', allowed_features: ['knowledge', 'kb_query_log'] });
    const free = await userStore.createPlan({ name: 'QC free', tier: null, allowed_features: ['knowledge'] });
    for (const [id, plan] of [[ORG, enterprise], [ORG_OTHER, enterprise], [ORG_FREE, free]]) {
        await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
    }
    for (const u of [ADMIN, MEMBER, SUBJECT, BYSTANDER, ADMIN_OTHER, SUBJECT_OTHER, ADMIN_FREE]) await userStore.createUser({ ...u, passwordHash: 'x' });
    await require('../../stores/complianceStore').initDB();
    const dsr = require('../../stores/dsrStore');
    const kbStore = require('../../stores/knowledgeBases');
    kbId = (await kbStore.createKB(ADMIN.id, 'Handbook', '', ORG, { isPublished: true })).id;
    kbIdOther = (await kbStore.createKB(ADMIN_OTHER.id, 'Their handbook', '', ORG_OTHER, { isPublished: true })).id;
    kbIdFree = (await kbStore.createKB(ADMIN_FREE.id, 'Free handbook', '', ORG_FREE, { isPublished: true })).id;
    const manual = (org, who, email) => dsr.createManual(org, { subject_email: email, request_type: 'access', created_by: who });
    openRequest = (await manual(ORG, ADMIN.id, SUBJECT.email)).id;
    closedRequest = (await manual(ORG, ADMIN.id, SUBJECT.email)).id;
    await dsr.updateStatus(ORG, closedRequest, 'fulfilled', { fulfilledBy: ADMIN.id });
    otherOrgRequest = (await manual(ORG_OTHER, ADMIN_OTHER.id, SUBJECT_OTHER.email)).id;
    bystanderRequest = (await manual(ORG, ADMIN.id, BYSTANDER.email)).id;
    store = require('../../stores/kb/queryLog/index.mts');
    api = h.serve('/', require('./kbQueryLog'), { user: ADMIN });
}, { timeout: 120_000 });

after(async () => {
    crypto._setCryptoDeps(null);
    await api.close();
    await closePg();
});

beforeEach(async () => {
    await pg.exec('DELETE FROM kb_query_log; DELETE FROM access_audit_log; DELETE FROM compliance_evidence');
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false`);
});

const SECRET_QUERY = 'what is my colleague Jan Peters salary?';
const entry = (over = {}) => ({
    searchGroupId: `g-${Math.random()}`, organizationId: ORG, kbId, userId: SUBJECT.id, channel: 'direct_chat', channelRef: { conversationId: 'conv-secret' },
    query: SECRET_QUERY, chunks: [{ chunkId: 'c1', documentId: 'd1', title: 'Pay policy', score: 0.4, text: 'Salaries are confidential passage.' }],
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
const audit = async () => (await pg.query('SELECT action, target_type, target_id, changed_by, organization_id, new_values FROM access_audit_log ORDER BY created_at, id')).rows;
const as = (user) => ({ user });
const withoutAuditTable = async (fn) => {
    await pg.exec('ALTER TABLE access_audit_log RENAME TO access_audit_log_off');
    try { await fn(); } finally { await pg.exec('ALTER TABLE access_audit_log_off RENAME TO access_audit_log'); }
};

// ── Gates and organisation ──────────────────────────────────────────

test('a member without admin_compliance is refused on every route', async () => {
    for (const [method, url] of [
        ['GET', '/kb-query-log/overview'], ['GET', '/kb-query-log/entries'], ['GET', '/kb-query-log/entries/export.csv'],
        ['GET', `/kb-query-log/subjects/${SUBJECT.id}`], ['GET', `/kb-query-log/subjects/${SUBJECT.id}/content?dsrRequestId=${openRequest}`],
        ['GET', `/kb-query-log/subjects/${SUBJECT.id}/export?dsrRequestId=${openRequest}`], ['DELETE', `/kb-query-log/subjects/${SUBJECT.id}`],
    ]) {
        assert.equal((await api.call(method, url, { user: MEMBER, body: method === 'DELETE' ? { dsrRequestId: openRequest, reason: 'x' } : undefined })).status, 403, `${method} ${url}`);
    }
});

test('no session is a 401', async () => {
    assert.equal((await api.call('GET', '/kb-query-log/overview', { user: null })).status, 401);
});

// ── Overview and entries: no text ───────────────────────────────────

test('the overview lists the bases with term, who changed it, managers and counts, and no text', async () => {
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_retention_days = 180, query_log_changed_by = '${ADMIN.id}', query_log_changed_at = now() - interval '1 minute',
        query_log_attestation = '{"purpose":"ai_quality","dpia":"not_required","worksCouncil":"not_applicable","worksCouncilReason":"no_works_council","privacyNoticeUpdated":true}',
        query_log_attested_by = '${ADMIN.id}', query_log_attested_at = now(), query_log_ai_act_high_risk = true WHERE id = '${kbId}'`);
    await pg.exec(`DELETE FROM kb_query_log_ack; INSERT INTO kb_query_log_ack (user_id, kb_id) VALUES ('${SUBJECT.id}', '${kbId}'), ('${BYSTANDER.id}', '${kbId}')`);
    await seed([{ id: 'o1' }, { id: 'o2', outcome: 'no_results' }, { id: 'o3', outcome: 'error', userId: BYSTANDER.id }]);
    const res = await api.call('GET', '/kb-query-log/overview', as(ADMIN));
    assert.equal(res.status, 200);
    assert.equal(res.body.licensed, true);
    assert.equal(res.body.anyEnabled, true);
    assert.equal(res.body.kbs.length, 1, 'only bases that log or hold rows, of this organisation');
    const kb = res.body.kbs[0];
    assert.equal(kb.id, kbId);
    assert.equal(kb.enabled, true);
    assert.equal(kb.retentionDays, 180);
    assert.equal(kb.changedBy, ADMIN.id);
    assert.ok(kb.managers.some((m) => m.id === ADMIN.id), 'the owner is a manager');
    assert.equal(kb.acknowledgedUsers, 2);
    assert.equal(kb.attestation.worksCouncil, 'not_applicable');
    assert.equal(kb.attestedBy, ADMIN.id);
    assert.ok(kb.attestedAt);
    assert.equal(kb.showNames, false);
    assert.equal(kb.highRisk, true);
    assert.equal(kb.total, 3);
    assert.deepEqual(kb.byOutcome, { answered: 1, no_results: 1, error: 1 });
    assert.equal(kb.byStatus.to_review, 3);
    assert.ok(!res.text.includes(SECRET_QUERY) && !res.text.includes('Salaries'), 'no content in the overview');
    assert.ok(!res.text.includes('Handbook-other') && !res.text.includes('Their handbook'));
});

test('the entries are metadata only: no query, answer, passages or channel reference', async () => {
    await seed([{ id: 'e1' }]);
    const res = await api.call('GET', '/kb-query-log/entries', as(ADMIN));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    const row = res.body.rows[0];
    assert.equal(row.kbName, 'Handbook');
    assert.equal(row.userName, 'Sam Subject');
    assert.equal(row.outcome, 'answered');
    assert.equal(row.chunkCount, 1);
    for (const k of ['query', 'answer', 'chunks', 'reviewNote', 'channelRef']) assert.ok(!(k in row), `${k} must not be in a metadata row`);
    assert.ok(!res.text.includes(SECRET_QUERY) && !res.text.includes('conv-secret') && !res.text.includes('Salaries'));
});

test('the entries filter on base, user, channel, outcome and period; and stay inside the organisation', async () => {
    await seed([
        { id: 'f1', createdAt: '2026-11-01T10:00:00Z' },
        { id: 'f2', createdAt: '2026-11-02T10:00:00Z', channel: 'agent_chat', userId: BYSTANDER.id, outcome: 'no_results', chunks: [] },
        { id: 'f3', organizationId: ORG_OTHER, kbId: kbIdOther, userId: SUBJECT_OTHER.id, searchGroupId: 'gx' },
    ]);
    const ids = async (qs) => (await api.call('GET', `/kb-query-log/entries${qs}`, as(ADMIN))).body.rows.map((r) => r.id).sort();
    assert.deepEqual(await ids(''), ['f1', 'f2']);
    assert.deepEqual(await ids('?channel=agent_chat'), ['f2']);
    assert.deepEqual(await ids(`?userId=${SUBJECT.id}`), ['f1']);
    assert.deepEqual(await ids('?outcome=no_results'), ['f2']);
    assert.deepEqual(await ids('?from=2026-11-02T00:00:00Z'), ['f2']);
    assert.deepEqual(await ids(`?kbId=${kbIdOther}`), [], 'another organisation\'s base gives nothing');
    const other = await api.call('GET', '/kb-query-log/entries', as(ADMIN_OTHER));
    assert.deepEqual(other.body.rows.map((r) => r.id), ['f3']);
});

test('the metadata CSV has the columns, no text, is audited and escapes formulas in names', async () => {
    await seed([{ id: 'c1' }]);
    await pg.query(`UPDATE users SET "displayName" = '=cmd|calc' WHERE id = $1`, [SUBJECT.id]);
    try {
        const res = await api.call('GET', '/kb-query-log/entries/export.csv', as(ADMIN));
        assert.equal(res.status, 200);
        const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
        assert.equal(lines[0], 'createdAt,knowledgeBase,user,channel,outcome,reviewStatus,chunkCount,topScore,model');
        assert.equal(lines.length, 2);
        assert.ok(lines[1].includes("'=cmd|calc"), lines[1]);
        assert.ok(!res.text.includes(SECRET_QUERY));
        const rows = (await audit()).filter((r) => r.action === 'kb.query_log.exported');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].organization_id, ORG);
        assert.equal(rows[0].target_type, 'organization');
    } finally {
        await pg.query(`UPDATE users SET "displayName" = 'Sam Subject' WHERE id = $1`, [SUBJECT.id]);
    }
    await withoutAuditTable(async () => {
        assert.equal((await api.call('GET', '/kb-query-log/entries/export.csv', as(ADMIN))).status, 503);
    });
});

// ── Subjects ────────────────────────────────────────────────────────

test('subject counts per base, scoped to the organisation', async () => {
    await seed([{ id: 's1' }, { id: 's2' }, { id: 's3', organizationId: ORG_OTHER, kbId: kbIdOther, searchGroupId: 'gy' }]);
    const res = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}`, as(ADMIN));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.deepEqual(res.body.byKb, [{ kbId, kbName: 'Handbook', count: 2 }]);
    assert.ok(!res.text.includes(SECRET_QUERY));
    const foreign = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}`, as(ADMIN_OTHER));
    assert.deepEqual(foreign.body.byKb.map((k) => k.kbId), [kbIdOther], 'an admin of another organisation sees only their own organisation\'s rows');
    assert.equal(foreign.body.total, 1);
    assert.equal(foreign.body.userName, null);
});

test('the content needs a dsrRequestId: none, unknown, closed, another organisation, another person all refuse', async () => {
    await seed([{ id: 'p1' }]);
    const get = (q) => api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/content${q}`, as(ADMIN));
    const missing = await get('');
    assert.equal(missing.status, 400);
    assert.ok(!missing.text.includes(SECRET_QUERY));
    for (const id of [99999, closedRequest, otherOrgRequest, bystanderRequest]) {
        const res = await get(`?dsrRequestId=${id}`);
        assert.equal(res.status, 403, `request ${id}`);
        assert.ok(!res.text.includes(SECRET_QUERY));
    }
    assert.deepEqual((await audit()).filter((r) => r.action === 'kb.query_log.content_viewed'), [], 'a refusal is no view');
});

test('with an open request about that person the content is shown, and the audit row exists', async () => {
    await seed([{ id: 'v1' }]);
    const res = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/content?dsrRequestId=${openRequest}`, as(ADMIN));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.rows[0].query, SECRET_QUERY);
    assert.equal(res.body.rows[0].chunks[0].text, 'Salaries are confidential passage.');
    assert.equal(res.body.rows[0].kbName, 'Handbook');
    assert.ok(!('organizationId' in res.body.rows[0]));
    const viewed = (await audit()).filter((r) => r.action === 'kb.query_log.content_viewed');
    assert.equal(viewed.length, 1);
    assert.equal(viewed[0].target_type, 'user');
    assert.equal(viewed[0].target_id, SUBJECT.id);
    assert.equal(viewed[0].changed_by, ADMIN.id);
    assert.equal(viewed[0].organization_id, ORG);
    assert.equal(JSON.parse(viewed[0].new_values).dsrRequestId, openRequest);
});

test('when the audit write fails no content leaves', async () => {
    await seed([{ id: 'v2' }]);
    await withoutAuditTable(async () => {
        const res = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/content?dsrRequestId=${openRequest}`, as(ADMIN));
        assert.equal(res.status, 503);
        assert.ok(!res.text.includes(SECRET_QUERY) && !res.text.includes('Salaries'));
    });
});

test('another organisation\'s admin cannot open this organisation\'s request or rows', async () => {
    await seed([{ id: 'x1' }]);
    const res = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/content?dsrRequestId=${openRequest}`, as(ADMIN_OTHER));
    assert.equal(res.status, 403);
});

test('the subject export gives JSON or CSV, needs the open request and is audited first', async () => {
    await seed([{ id: 'j1', query: '=SUM(A1)' }]);
    const bad = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/export?dsrRequestId=${closedRequest}`, as(ADMIN));
    assert.equal(bad.status, 403);

    const json = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/export?dsrRequestId=${openRequest}`, as(ADMIN));
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-disposition'), /attachment/);
    assert.equal(json.body.total, 1);
    assert.equal(json.body.entries[0].query, '=SUM(A1)');

    const csv = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/export?dsrRequestId=${openRequest}&format=csv`, as(ADMIN));
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok(csv.text.includes("'=SUM(A1)"), 'formula pinned as text');

    assert.equal((await audit()).filter((r) => r.action === 'kb.query_log.subject_exported').length, 2);
    await withoutAuditTable(async () => {
        const res = await api.call('GET', `/kb-query-log/subjects/${SUBJECT.id}/export?dsrRequestId=${openRequest}`, as(ADMIN));
        assert.equal(res.status, 503);
        assert.ok(!res.text.includes('SUM'));
    });
});

test('erasure removes only that person\'s rows in that organisation, audits it and records evidence', async () => {
    await seed([
        { id: 'd1' }, { id: 'd2', searchGroupId: 'g2' },
        { id: 'd3', userId: BYSTANDER.id, searchGroupId: 'g3' },
        { id: 'd4', organizationId: ORG_OTHER, kbId: kbIdOther, userId: SUBJECT.id, searchGroupId: 'g4' },
    ]);
    const refused = await api.call('DELETE', `/kb-query-log/subjects/${SUBJECT.id}`, { ...as(ADMIN), body: { dsrRequestId: closedRequest, reason: 'closed' } });
    assert.equal(refused.status, 403);
    const noReason = await api.call('DELETE', `/kb-query-log/subjects/${SUBJECT.id}`, { ...as(ADMIN), body: { dsrRequestId: openRequest } });
    assert.equal(noReason.status, 400);
    assert.equal((await pg.query('SELECT id FROM kb_query_log')).rows.length, 4, 'nothing deleted yet');

    const res = await api.call('DELETE', `/kb-query-log/subjects/${SUBJECT.id}`, { ...as(ADMIN), body: { dsrRequestId: openRequest, reason: 'Art. 17 request #1' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
    assert.deepEqual((await pg.query('SELECT id FROM kb_query_log ORDER BY id')).rows.map((r) => r.id), ['d3', 'd4']);

    const rows = (await audit()).filter((r) => r.action === 'kb.query_log.subject_deleted');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target_id, SUBJECT.id);
    assert.equal(JSON.parse(rows[0].new_values).reason, 'Art. 17 request #1');
    const ev = (await pg.query(`SELECT check_id, subject_id, payload FROM compliance_evidence WHERE organization_id = $1`, [ORG])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].check_id, 'GDPR-Art5-kb-query-log');
    assert.equal(ev[0].payload.deleted, 2);
    assert.ok(!JSON.stringify(ev[0].payload).includes(SUBJECT.email));
});

test('erasure whose audit write fails deletes nothing', async () => {
    await seed([{ id: 'z1' }]);
    await withoutAuditTable(async () => {
        const res = await api.call('DELETE', `/kb-query-log/subjects/${SUBJECT.id}`, { ...as(ADMIN), body: { dsrRequestId: openRequest, reason: 'x' } });
        assert.equal(res.status, 503);
    });
    assert.equal((await pg.query('SELECT id FROM kb_query_log')).rows.length, 1);
});

// ── No licence ──────────────────────────────────────────────────────

test('the compliance routes keep working without the kb_query_log licence', async () => {
    await seed([{ id: 'n1', organizationId: ORG_FREE, kbId: kbIdFree, userId: ADMIN_FREE.id, searchGroupId: 'gf' }]);
    const overview = await api.call('GET', '/kb-query-log/overview', as(ADMIN_FREE));
    assert.equal(overview.status, 200);
    assert.equal(overview.body.licensed, false);
    assert.equal(overview.body.kbs[0].total, 1, 'rows that remain after the licence ended are still visible');
    assert.equal((await api.call('GET', '/kb-query-log/entries', as(ADMIN_FREE))).body.total, 1);
    assert.equal((await api.call('GET', `/kb-query-log/subjects/${ADMIN_FREE.id}`, as(ADMIN_FREE))).body.total, 1);
});
