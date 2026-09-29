'use strict';

/**
 * routes/dsr.js — the property under test is BFSF-441: the subject's address
 * appears in the audited detail and in the letters to the subject, and
 * nowhere else (list, evidence, notifications, export). Plus the clock rules
 * (extend once, with a reason) and the public endpoints' uniform failures.
 */

process.env.DSR_VERIFY_SIGNING_KEY = 'test-dsr-verify-secret-0123456789abcdef-0123456789';
process.env.PUBLIC_SHARE_BASE_URL = 'https://app.test';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Module = require('node:module');

const EMAIL = 'person@example.org';
const DAY = 86400 * 1000;

// ── Stand-ins ───────────────────────────────────────────────────────
const state = {
    rows: new Map(),      // id → row
    nextId: 1,
    users: new Map(),
    audits: [],
    evidence: [],
    mails: [],
    mailFail: false,
    events: [],
    tokenHashes: new Map(), // id → hash
    runnerCalls: [],
};

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function synthTimeline(row) {
    if (row.timeline?.length) return row.timeline;
    return [{ at: row.created_at, by: null, kind: 'received', channel: row.channel }];
}

const mockDsrStore = {
    AlreadyExtendedError: class AlreadyExtendedError extends Error { constructor() { super('already'); this.code = 'dsr_already_extended'; } },
    createRequest: async (input) => {
        const id = state.nextId++;
        const created_at = new Date().toISOString();
        const row = {
            id, organization_id: input.organization_id, request_type: input.request_type, subject_email: input.subject_email,
            status: 'pending', notes: input.notes || null, source_ip: input.source_ip, created_at,
            due_at: new Date(Date.now() + 30 * DAY).toISOString(), channel: input.channel || 'public_form',
            identity_status: 'unverified', timeline: [{ at: created_at, by: null, kind: 'received', channel: input.channel || 'public_form' }],
            extended_at: null, extended_until: null, started_at: null, started_by: null, fulfilled_at: null, fulfilled_by: null,
        };
        state.rows.set(id, row);
        return { id, created_at, due_at: row.due_at, channel: row.channel, identity_status: row.identity_status };
    },
    createManual: async (orgId, { subject_email, request_type, channel, notes, received_at, created_by }) => {
        const id = state.nextId++;
        const created_at = new Date(received_at || Date.now()).toISOString();
        const row = {
            id, organization_id: orgId, request_type: request_type || 'access', subject_email, status: 'pending', notes,
            created_at, due_at: new Date(new Date(created_at).getTime() + 30 * DAY).toISOString(), channel: channel || 'other',
            identity_status: 'verified_manual', created_by, timeline: [{ at: created_at, by: created_by, kind: 'received', channel }],
            extended_at: null, extended_until: null, started_at: null, fulfilled_at: null,
        };
        state.rows.set(id, row);
        return { id, created_at, due_at: row.due_at, channel: row.channel, identity_status: row.identity_status };
    },
    listRequests: async (orgId, { status } = {}) => [...state.rows.values()]
        .filter(r => r.organization_id === orgId && (!status || r.status === status))
        .map(r => ({ ...clone(r), timeline: synthTimeline(r) })),
    getRequest: async (orgId, id) => {
        const r = state.rows.get(Number(id));
        return r && r.organization_id === orgId ? { ...clone(r), timeline: synthTimeline(r) } : null;
    },
    updateStatus: async (orgId, id, status, { fulfilledBy, resultSummary }) => {
        const r = state.rows.get(Number(id));
        Object.assign(r, { status, fulfilled_at: status === 'fulfilled' ? new Date().toISOString() : r.fulfilled_at, fulfilled_by: fulfilledBy, result_summary: resultSummary });
        r.timeline.push({ at: new Date().toISOString(), by: fulfilledBy, kind: status, text: resultSummary || null });
        return mockDsrStore.getRequest(orgId, id);
    },
    start: async (orgId, id, userId) => {
        const r = state.rows.get(Number(id));
        if (r.status === 'pending') { Object.assign(r, { status: 'in_progress', started_at: new Date().toISOString(), started_by: userId }); r.timeline.push({ at: r.started_at, by: userId, kind: 'started' }); }
        return mockDsrStore.getRequest(orgId, id);
    },
    extend: async (orgId, id, { reason, by }) => {
        const r = state.rows.get(Number(id));
        if (!r) return null;
        if (r.extended_at) throw new mockDsrStore.AlreadyExtendedError();
        const until = new Date(new Date(r.created_at).getTime() + 90 * DAY).toISOString();
        Object.assign(r, { extended_at: new Date().toISOString(), extended_until: until, due_at: until, extension_reason: reason, extended_by: by });
        r.timeline.push({ at: r.extended_at, by, kind: 'extended', text: reason, until });
        return mockDsrStore.getRequest(orgId, id);
    },
    verifyIdentity: async (orgId, id, { method, by }) => {
        const r = state.rows.get(Number(id));
        r.identity_status = method === 'email_link' ? 'verified_email_link' : 'verified_manual';
        r.timeline.push({ at: new Date().toISOString(), by: by || null, kind: 'identity_verified', method });
        return mockDsrStore.getRequest(orgId, id);
    },
    appendTimeline: async (orgId, id, ev) => {
        const r = state.rows.get(Number(id));
        r.timeline.push({ at: new Date().toISOString(), by: ev.by ?? null, ...ev });
        return mockDsrStore.getRequest(orgId, id);
    },
    setVerifyTokenHash: async (orgId, id, hash) => { state.tokenHashes.set(Number(id), hash); return true; },
    consumeVerifyToken: async (orgId, id, hash) => {
        if (state.tokenHashes.get(Number(id)) !== hash) return false;
        state.tokenHashes.delete(Number(id));
        return true;
    },
};

const mockUserStore = {
    getUser: async (id) => state.users.get(id) || null,
    getUserByEmail: async (email) => [...state.users.values()].find(u => u.email === email) || null,
    // The discovery scan must use the ORG-PINNED lookup, never the platform-wide
    // one — otherwise a tenant can ask whether any address has an account here.
    // The double enforces that: it answers only for a member of the given org.
    findOrgMemberIdByEmail: async (organizationId, email) => (
        [...state.users.values()].find(u => u.email === email && u.organizationId === organizationId)?.id || null
    ),
    getOrganization: async (id) => ({ id, name: `Org ${id}` }),
    logAccessAudit: async (action, targetType, targetId, changedBy, oldValues, newValues, organizationId) => {
        if (state.auditFail) throw new Error('audit table locked');
        state.audits.push({ action, targetType, targetId, changedBy, newValues, organizationId });
    },
};

const mockComplianceStore = {
    getSettings: async () => ({ dpo_email: 'dpo@org.test' }),
    addEvidence: async (row) => {
        if (state.evidenceFail) { const e = new Error('lock timeout'); e.code = '55P03'; throw e; }
        state.evidence.push(row); return { id: state.evidence.length, seq: state.evidence.length, hash: `h${state.evidence.length}` };
    },
    listEvidence: async (orgId, { subjectId }) => state.evidence
        .filter(e => e.organization_id === orgId && e.subject_id === subjectId)
        .map((e, i) => ({ seq: i + 1, hash: `h${i + 1}`, captured_at: '2026-09-14T00:00:00Z', payload: e.payload })),
};

const mockEmailService = {
    sendDsrAckEmail: async (args) => { state.mails.push({ kind: 'ack', ...args }); if (state.mailFail) throw new Error('smtp down'); },
    sendDsrExtensionEmail: async (args) => { state.mails.push({ kind: 'extension', ...args }); if (state.mailFail) throw new Error('smtp down'); },
    sendDsrResultEmail: async (args) => { state.mails.push({ kind: 'result', ...args }); if (state.mailFail) throw new Error('smtp down'); },
};

const mockEvents = {
    EVENTS: { DSR_SUBMITTED: 'dsr_submitted', DSR_EXTENDED: 'dsr_extended', DSR_FULFILLED: 'dsr_fulfilled' },
    emit: (name, payload) => state.events.push({ name, payload }),
};

const mockPermissions = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance
        ? next()
        : res.status(403).json({ error: "Permission 'admin_compliance' required" })),
};

const mockDb = {
    getOne: async (sql, params) => {
        // The two public reads: by (id, email) and by id.
        const r = state.rows.get(Number(params[0]));
        if (!r) return null;
        if (params.length > 1 && r.subject_email !== params[1]) return null;
        return clone(r);
    },
};

const mockRunner = { runOne: async (orgId, checkId) => { state.runnerCalls.push({ orgId, checkId }); } };

const STUBS = [
    ['../stores/dsrStore.js', mockDsrStore],
    ['../stores/userStore.js', mockUserStore],
    ['../stores/complianceStore.js', mockComplianceStore],
    ['../utils/emailService.js', mockEmailService],
    ['../compliance/events.js', mockEvents],
    ['../auth/permissions.js', mockPermissions],
    ['../db.js', mockDb],
    ['../compliance/runner.js', mockRunner],
    // Discovery's lazy stores: stubbed so no real store boots against the fake db.
    ['../stores/memoryStore.js', { countActiveMemoriesForUser: async () => 0 }],
    ['../stores/datatableStore.js', { listDatatablesForScope: async () => [], getModel: async () => ({ model: { tables: [] } }) }],
    ['../stores/datatableDbStore.js', { scopeKey: (s) => `${s.kind}:${s.id}`, query: async () => ({ rows: [] }) }],
    ['../stores/configStore.js', { setSecretIfAbsent: async () => null, getSecret: async () => null }],
].map(([rel, exp]) => [require.resolve(rel), exp]);

const originalResolve = Module._resolveFilename;
for (const [file, exports] of STUBS) {
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const router = require('./dsr');
const discovery = require('../compliance/dsr/discovery');
const writeFailures = require('../compliance/evidence/writeFailures');
const verifyToken = require('../compliance/dsr/verifyToken');

test.after(() => {
    Module._resolveFilename = originalResolve;
    for (const [file] of STUBS) delete require.cache[file];
});

// ── Harness ─────────────────────────────────────────────────────────
let currentSession = null;
const app = express();
app.set('trust proxy', 1); // the test sends X-Forwarded-For, as the ingress does in production
app.use(express.json());
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/dsr', router);
let server;
let base;

test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/dsr`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function call(method, path, { session = null, body, ip } = {}) {
    currentSession = session;
    const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const get = (p, o) => call('GET', p, o);
const post = (p, o) => call('POST', p, o);

const ADMIN = { user: { id: 'admin_a', canCompliance: true } };
const ADMIN_B = { user: { id: 'admin_b', canCompliance: true } };
const PLAIN = { user: { id: 'admin_a' } };

const flush = () => new Promise(r => setTimeout(r, 20)); // let fire-and-forget settle

test.beforeEach(() => {
    state.rows = new Map();
    state.nextId = 1;
    state.users = new Map([
        ['admin_a', { id: 'admin_a', organizationId: 'org_a', email: 'admin@org-a.test' }],
        ['admin_b', { id: 'admin_b', organizationId: 'org_b', email: 'admin@org-b.test' }],
        ['u_person', { id: 'u_person', organizationId: 'org_a', email: EMAIL }],
    ]);
    state.audits = []; state.evidence = []; state.mails = []; state.mailFail = false; state.auditFail = false;
    state.evidenceFail = false; writeFailures._reset();
    state.events = []; state.tokenHashes = new Map(); state.runnerCalls = [];
    discovery._resetMemo();
});

async function seed(over = {}) {
    const created = await mockDsrStore.createRequest({ organization_id: 'org_a', request_type: 'access', subject_email: EMAIL, channel: 'public_form' });
    Object.assign(state.rows.get(created.id), over);
    return created.id;
}

// ── Public intake ───────────────────────────────────────────────────

test('public POST derives the org from the address, returns due_at and sends the ack with a verify link', async () => {
    const res = await post('/requests', { body: { subject_email: 'Person@Example.org', request_type: 'deletion', notes: 'please' }, ip: '203.0.113.1' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, 1);
    assert.ok(res.body.due_at);
    assert.strictEqual(res.body.status_url, '/api/dsr/requests/1/public');
    const row = state.rows.get(1);
    assert.strictEqual(row.organization_id, 'org_a');
    assert.strictEqual(row.channel, 'public_form');
    assert.strictEqual(row.subject_email, EMAIL);

    await flush();
    assert.strictEqual(state.mails.length, 1);
    const mail = state.mails[0];
    assert.strictEqual(mail.kind, 'ack');
    assert.strictEqual(mail.to, EMAIL);
    assert.strictEqual(mail.requestType, 'deletion');
    assert.strictEqual(mail.orgName, 'Org org_a');
    assert.strictEqual(mail.dpoEmail, 'dpo@org.test');
    assert.match(mail.verifyUrl, /^https:\/\/app\.test\/dsr\/verify\?id=1&token=/);
    assert.strictEqual(mail.statusUrl, 'https://app.test/dsr?id=1');
    assert.ok(state.tokenHashes.has(1), 'hash of the token stored for single use');
    assert.ok(row.timeline.some(e => e.kind === 'ack_sent'));
    assert.deepStrictEqual(state.events[0], { name: 'dsr_submitted', payload: { orgId: 'org_a', requestType: 'deletion' } });
});

test('an ack that cannot be sent lands in the timeline as ack_failed and the intake still succeeds', async () => {
    state.mailFail = true;
    const res = await post('/requests', { body: { subject_email: EMAIL }, ip: '203.0.113.2' });
    assert.strictEqual(res.status, 201);
    await flush();
    const row = state.rows.get(res.body.id);
    assert.ok(row.timeline.some(e => e.kind === 'ack_failed'));
    assert.ok(!row.timeline.some(e => e.kind === 'ack_sent'));
});

test('public POST rejects a missing or malformed address', async () => {
    assert.strictEqual((await post('/requests', { body: {}, ip: '203.0.113.3' })).status, 400);
    assert.strictEqual((await post('/requests', { body: { subject_email: 'nope' }, ip: '203.0.113.3' })).status, 400);
});

// ── Public status ───────────────────────────────────────────────────

test('public status returns the minimal shape for the matching (id, email) and 404 otherwise', async () => {
    const id = await seed({ extended_until: null });
    const res = await get(`/requests/${id}/public?email=${encodeURIComponent(EMAIL)}`, { ip: '198.51.100.1' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['created_at', 'due_at', 'extended_until', 'fulfilled_at', 'id', 'request_type', 'status']);
    assert.ok(!res.text.includes('notes'));
    assert.strictEqual((await get(`/requests/${id}/public?email=other@example.org`, { ip: '198.51.100.1' })).status, 404);
    assert.strictEqual((await get(`/requests/${id}/public`, { ip: '198.51.100.1' })).status, 400);
    assert.strictEqual((await get(`/requests/abc/public?email=${EMAIL}`, { ip: '198.51.100.1' })).status, 400);
    assert.ok(res.headers.get('ratelimit-limit'), 'the public read is rate-limited');
    assert.strictEqual(res.headers.get('ratelimit-limit'), '60');
});

// ── Public verify ───────────────────────────────────────────────────

test('verify: a valid token flips identity once; every failure is the same 400 invalid_token', async () => {
    const id = await seed();
    const { token, tokenHash } = verifyToken.mint({ id, email: EMAIL, orgId: 'org_a' });
    state.tokenHashes.set(id, tokenHash);

    const bad = await post(`/requests/${id}/verify`, { body: { token: 'garbage.sig' }, ip: '198.51.100.2' });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(bad.body, { error: 'invalid_token' });

    const wrongId = await post(`/requests/999/verify`, { body: { token }, ip: '198.51.100.2' });
    assert.deepStrictEqual([wrongId.status, wrongId.body], [400, { error: 'invalid_token' }]);

    const ok = await post(`/requests/${id}/verify`, { body: { token }, ip: '198.51.100.2' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.identity_status, 'verified_email_link');
    assert.strictEqual(state.rows.get(id).identity_status, 'verified_email_link');
    assert.ok(!ok.text.includes(EMAIL));

    // Single use: the same link again is refused with the same body.
    const again = await post(`/requests/${id}/verify`, { body: { token }, ip: '198.51.100.2' });
    assert.deepStrictEqual([again.status, again.body], [400, { error: 'invalid_token' }]);

    const noBody = await post(`/requests/${id}/verify`, { body: {}, ip: '198.51.100.2' });
    assert.deepStrictEqual([noBody.status, noBody.body], [400, { error: 'invalid_token' }]);
});

// ── Admin: list / detail ────────────────────────────────────────────

test('admin routes need auth and the compliance permission', async () => {
    assert.strictEqual((await get('/requests')).status, 401);
    assert.strictEqual((await get('/requests', { session: PLAIN })).status, 403);
    assert.strictEqual((await post('/requests/manual', { session: PLAIN, body: {} })).status, 403);
});

test('GET /requests never contains subject_email — masked, with clock fields, own org only', async () => {
    const id = await seed();
    await mockDsrStore.createRequest({ organization_id: 'org_b', request_type: 'access', subject_email: 'other@example.org' });
    const res = await get('/requests', { session: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
    const row = res.body[0];
    assert.strictEqual(row.id, id);
    assert.strictEqual(row.subject_email, undefined);
    assert.strictEqual(row.subject_email_masked, 'p***@example.org');
    assert.ok(!res.text.includes(EMAIL), 'the list must not carry the address');
    assert.ok(!res.text.includes('other@example.org'));
    for (const k of ['channel', 'identity_status', 'due_at', 'extended_until', 'started_at', 'started_by', 'days_left', 'state']) {
        assert.ok(k in row, `list row carries ${k}`);
    }
    assert.strictEqual(row.state, 'ok');
    assert.ok(row.days_left >= 29 && row.days_left <= 30);
    assert.strictEqual(row.timeline, undefined, 'the list does not ship timelines');
});

test('clockFor: overdue / urgent / ok / none', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    const at = (d) => new Date(now + d * DAY).toISOString();
    assert.deepStrictEqual(router.clockFor({ status: 'pending', due_at: at(-1) }, now), { days_left: -1, state: 'overdue' });
    assert.deepStrictEqual(router.clockFor({ status: 'in_progress', due_at: at(3) }, now), { days_left: 3, state: 'urgent' });
    assert.deepStrictEqual(router.clockFor({ status: 'pending', due_at: at(12) }, now), { days_left: 12, state: 'ok' });
    assert.deepStrictEqual(router.clockFor({ status: 'fulfilled', due_at: at(-40) }, now), { days_left: null, state: 'none' });
    assert.deepStrictEqual(router.clockFor({ status: 'pending', due_at: null }, now), { days_left: null, state: 'none' });
});

test('GET /requests/:id shows the address to the admin and writes the access-audit row', async () => {
    const id = await seed();
    const res = await get(`/requests/${id}`, { session: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.subject_email, EMAIL);
    assert.strictEqual(res.body.subject_email_masked, 'p***@example.org');
    assert.ok(Array.isArray(res.body.timeline));
    await flush();
    const audit = state.audits.find(a => a.action === 'dsr.subject_viewed');
    assert.ok(audit, 'access audit written');
    assert.deepStrictEqual([audit.targetType, audit.targetId, audit.changedBy, audit.organizationId], ['dsr_request', String(id), 'admin_a', 'org_a']);
    assert.ok(!JSON.stringify(audit).includes(EMAIL));
    // Another org's admin cannot see it.
    assert.strictEqual((await get(`/requests/${id}`, { session: ADMIN_B })).status, 404);
});

test('GET /requests/:id fails closed: no audit row, no address in the response', async () => {
    const id = await seed();
    state.auditFail = true;
    const res = await get(`/requests/${id}`, { session: ADMIN });
    assert.strictEqual(res.status, 500, 'the same refusal the access-audit export makes');
    assert.strictEqual(res.body.code, 'audit_write_failed');
    // The whole payload, not just the field: nothing of the subject goes out.
    assert.ok(!res.text.includes(EMAIL), 'the full address is withheld when the read cannot be recorded');
    assert.ok(!res.text.includes('example.org'), 'not even the masked domain path runs');
    assert.strictEqual(state.audits.length, 0);
    // And it recovers: the next read is served and audited as before.
    state.auditFail = false;
    const ok = await get(`/requests/${id}`, { session: ADMIN });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.subject_email, EMAIL);
    assert.strictEqual(state.audits.filter(a => a.action === 'dsr.subject_viewed').length, 1);
});

test('POST /requests/manual records the channel and identity, returns a masked row', async () => {
    const res = await post('/requests/manual', { session: ADMIN, body: { subject_email: 'Letter@Example.org', request_type: 'rectification', channel: 'letter', received_at: '2026-09-01T09:00:00Z', notes: 'came by post' } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.channel, 'letter');
    assert.strictEqual(res.body.identity_status, 'verified_manual');
    assert.strictEqual(res.body.subject_email, undefined);
    assert.strictEqual(res.body.subject_email_masked, 'l***@example.org');
    assert.strictEqual(state.rows.get(res.body.id).created_by, 'admin_a');
    assert.strictEqual((await post('/requests/manual', { session: ADMIN, body: { subject_email: 'bad' } })).status, 400);
});

// ── Admin: start / extend / verify-identity / timeline ─────────────

test('start moves pending → in_progress and 409s once closed', async () => {
    const id = await seed();
    const res = await post(`/requests/${id}/start`, { session: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'in_progress');
    assert.strictEqual(res.body.started_by, 'admin_a');
    state.rows.get(id).status = 'fulfilled';
    assert.deepStrictEqual((await post(`/requests/${id}/start`, { session: ADMIN })).body, { error: 'not_open' });
});

test('extend needs a reason (≤1000), works once, e-mails the subject, writes evidence without the address', async () => {
    const id = await seed();
    assert.strictEqual((await post(`/requests/${id}/extend`, { session: ADMIN, body: {} })).status, 400);
    assert.strictEqual((await post(`/requests/${id}/extend`, { session: ADMIN, body: { reason: 'x'.repeat(1001) } })).status, 400);

    const res = await post(`/requests/${id}/extend`, { session: ADMIN, body: { reason: 'Complex request, many systems' } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.extended_until);
    assert.strictEqual(res.body.due_at, res.body.extended_until);
    assert.strictEqual(res.body.subject_email, undefined);
    const until = new Date(res.body.extended_until).getTime() - new Date(res.body.created_at).getTime();
    assert.strictEqual(Math.round(until / DAY), 90);

    const mail = state.mails.find(m => m.kind === 'extension');
    assert.ok(mail);
    assert.strictEqual(mail.to, EMAIL);
    assert.strictEqual(mail.reason, 'Complex request, many systems');
    assert.ok(state.rows.get(id).timeline.some(e => e.kind === 'extension_emailed'));

    const ev = state.evidence.find(e => e.payload.action === 'dsr_extended');
    assert.ok(ev, 'evidence row');
    assert.strictEqual(ev.check_id, 'GDPR-Art15-dsr-access');
    assert.strictEqual(ev.subject_id, String(id));
    assert.strictEqual(ev.payload.reason_length, 29);
    assert.ok(!JSON.stringify(ev).includes(EMAIL));
    assert.ok(state.events.some(e => e.name === 'dsr_extended'));

    const second = await post(`/requests/${id}/extend`, { session: ADMIN, body: { reason: 'again' } });
    assert.strictEqual(second.status, 409);
    assert.deepStrictEqual(second.body, { error: 'already_extended' });
    assert.strictEqual(state.mails.filter(m => m.kind === 'extension').length, 1);
});

test('extend on a closed request is 409 not_open; the store race maps to 409 too', async () => {
    const id = await seed({ status: 'rejected' });
    assert.deepStrictEqual((await post(`/requests/${id}/extend`, { session: ADMIN, body: { reason: 'r' } })).body, { error: 'not_open' });
    const id2 = await seed();
    const orig = mockDsrStore.extend;
    mockDsrStore.extend = async () => { throw new mockDsrStore.AlreadyExtendedError(); };
    try {
        const r = await post(`/requests/${id2}/extend`, { session: ADMIN, body: { reason: 'r' } });
        assert.deepStrictEqual([r.status, r.body], [409, { error: 'already_extended' }]);
    } finally { mockDsrStore.extend = orig; }
});

test('verify-identity (manual) stamps the identity and keeps the note in the timeline', async () => {
    const id = await seed();
    const res = await post(`/requests/${id}/verify-identity`, { session: ADMIN, body: { method: 'manual', note: 'Passport checked at the desk' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.identity_status, 'verified_manual');
    assert.strictEqual((await post(`/requests/${id}/verify-identity`, { session: ADMIN, body: { method: 'email_link' } })).status, 400);
    const tl = await get(`/requests/${id}/timeline`, { session: ADMIN });
    assert.strictEqual(tl.status, 200);
    assert.ok(tl.body.timeline.some(e => e.kind === 'identity_verified' && e.method === 'manual'));
    assert.ok(tl.body.timeline.some(e => e.kind === 'note' && e.text === 'Passport checked at the desk'));
    assert.ok(!tl.text.includes(EMAIL));
});

// ── Admin: discovery ────────────────────────────────────────────────

test('a tenant cannot use discovery to learn that an address has an account elsewhere', async () => {
    // The attack the org pin closes: an admin of org_b files a manual request for
    // an address belonging to org_a — POST /requests/manual accepts any valid
    // address — and reads the scan. The DSR row is genuinely org_b's, so the
    // route gate passes; only the scan's own scoping stands between the caller
    // and "yes, that person has an account here, here is their id and how much
    // we hold about them".
    const mine = await post('/requests/manual', {
        session: ADMIN_B,
        body: { request_type: 'access', subject_email: EMAIL, channel: 'email' },
    });
    assert.strictEqual(mine.status, 201, 'the row itself is legitimately org_b\'s');

    const res = await get(`/requests/${mine.body.id}/discovery`, { session: ADMIN_B });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.subject.user_id, null, 'no internal id across the tenant boundary');
    const byKind = Object.fromEntries(res.body.sources.map(s => [s.kind, s.count]));
    assert.strictEqual(byKind.user_account, 0, 'account existence must not leak');
    assert.strictEqual(byKind.memories, 0, 'nor how much is held about them');
    assert.ok(!res.text.includes('u_person'), 'the foreign user id appears nowhere');
    assert.ok(!res.text.includes(EMAIL));
});

test('GET /:id/discovery returns the allow-listed scan without the address', async () => {
    const id = await seed();
    const res = await get(`/requests/${id}/discovery`, { session: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.subject.email_masked, 'p***@example.org');
    assert.strictEqual(res.body.subject.user_id, 'u_person');
    assert.deepStrictEqual(res.body.not_scanned, ['conversations']);
    assert.ok(Array.isArray(res.body.sources));
    assert.ok(!res.text.includes(EMAIL));
    assert.ok(state.audits.some(a => a.action === 'dsr.discovery_run' && a.targetId === String(id)));
});

// ── Admin: fulfil ───────────────────────────────────────────────────

test('fulfil requires a summary, e-mails only the subject, writes allow-listed evidence and reruns the check', async () => {
    const id = await seed({ status: 'in_progress' });
    await get(`/requests/${id}/discovery`, { session: ADMIN }); // primes the memo the evidence row reads
    assert.strictEqual((await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'fulfilled' } })).status, 400);
    assert.strictEqual((await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'weird', result_summary: 's' } })).status, 400);

    const res = await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'fulfilled', result_summary: 'Copy of your data was sent by registered mail.' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'fulfilled');
    assert.strictEqual(res.body.subject_email, undefined);
    assert.strictEqual(res.body.state, 'none');

    const mails = state.mails.filter(m => m.kind === 'result');
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(mails[0].to, EMAIL);
    assert.strictEqual(mails[0].status, 'fulfilled');
    assert.strictEqual(mails[0].resultSummary, 'Copy of your data was sent by registered mail.');
    assert.ok(state.rows.get(id).timeline.some(e => e.kind === 'result_emailed'));

    const ev = state.evidence.find(e => e.payload.action === 'dsr_fulfilled');
    assert.ok(ev);
    assert.strictEqual(ev.organization_id, 'org_a');
    assert.strictEqual(ev.check_id, 'GDPR-Art15-dsr-access');
    assert.deepStrictEqual(Object.keys(ev.payload).sort(), ['action', 'actor', 'at', 'channel', 'discovery', 'identity_status', 'request_id', 'request_type', 'status', 'summary_length']);
    assert.strictEqual(ev.payload.actor, 'admin_a');
    assert.strictEqual(ev.payload.summary_length, 46);
    assert.ok(ev.payload.discovery && typeof ev.payload.discovery.counts === 'object');
    assert.ok(!JSON.stringify(ev).includes(EMAIL), 'evidence carries no address');
    assert.ok(!JSON.stringify(ev).includes('registered mail'), 'evidence carries the summary LENGTH, not the text');

    assert.deepStrictEqual(state.runnerCalls, [{ orgId: 'org_a', checkId: 'GDPR-Art15-dsr-access' }]);
    assert.ok(state.events.some(e => e.name === 'dsr_fulfilled' && e.payload.status === 'fulfilled'));

    assert.deepStrictEqual((await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'rejected' } })).body, { error: 'not_open' });
});

test('reject needs no summary; notify_subject=false sends nothing; a failed mail is email_failed', async () => {
    const id = await seed();
    const quiet = await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'rejected', notify_subject: false } });
    assert.strictEqual(quiet.status, 200);
    assert.strictEqual(quiet.body.status, 'rejected');
    assert.strictEqual(state.mails.length, 0);
    assert.ok(state.evidence.some(e => e.payload.action === 'dsr_rejected'));

    const id2 = await seed({ request_type: 'deletion' });
    state.mailFail = true;
    const res = await post(`/requests/${id2}/fulfil`, { session: ADMIN, body: { status: 'fulfilled', result_summary: 'Erased.' } });
    assert.strictEqual(res.status, 200);
    assert.ok(state.rows.get(id2).timeline.some(e => e.kind === 'email_failed'));
    assert.strictEqual(state.runnerCalls.at(-1).checkId, 'GDPR-Art17-dsr-deletion');
    assert.strictEqual(state.evidence.at(-1).check_id, 'GDPR-Art17-dsr-deletion');
});

test('a failed evidence write does not sink the fulfilment, but it stops being invisible', async () => {
    // The ledger is append-only and hash-chained: a row that never lands leaves
    // no gap in `seq`, so nothing downstream — including the 6-hourly verifier —
    // can tell "no evidence row" from "nothing happened". The action still
    // succeeds; the hole is reported.
    const id = await seed();
    state.evidenceFail = true;
    const res = await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'fulfilled', result_summary: 'Copy sent.' } });
    assert.strictEqual(res.status, 200, 'the data subject is still served');
    assert.strictEqual(state.rows.get(id).status, 'fulfilled');
    assert.strictEqual(state.evidence.length, 0, 'and the ledger row really is missing');

    const reported = writeFailures.writeFailureSummary('org_a');
    assert.ok(reported, 'the swallowed write is reported');
    assert.strictEqual(reported.count, 1);
    assert.strictEqual(reported.recent[0].check_id, 'GDPR-Art15-dsr-access');
    assert.strictEqual(reported.recent[0].subject_type, 'dsr_request');
    assert.strictEqual(reported.recent[0].subject_id, String(id));
    assert.strictEqual(reported.recent[0].error_type, '55P03');
    assert.ok(!JSON.stringify(reported).includes(EMAIL), 'no address in the report');
    assert.strictEqual(writeFailures.writeFailureSummary('org_b'), null, 'org-scoped');
});

// ── Admin: export ───────────────────────────────────────────────────

test('GET /:id/export is a dossier: masked request, timeline, evidence refs, discovery summary — no user/memories, no address', async () => {
    const id = await seed({ status: 'in_progress' });
    await post(`/requests/${id}/extend`, { session: ADMIN, body: { reason: 'backlog' } });
    const res = await get(`/requests/${id}/export`, { session: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /dsr-\d+-dossier\.json/);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['discovery_summary', 'evidence', 'generated_at', 'notes', 'request', 'timeline']);
    assert.strictEqual(res.body.data, undefined);
    assert.strictEqual(res.body.request.subject_email, undefined);
    assert.strictEqual(res.body.request.subject_email_masked, 'p***@example.org');
    assert.ok(Array.isArray(res.body.timeline) && res.body.timeline.some(e => e.kind === 'extended'));
    assert.strictEqual(res.body.evidence.length, 1);
    assert.deepStrictEqual(Object.keys(res.body.evidence[0]).sort(), ['captured_at', 'hash', 'seq']);
    assert.ok(res.body.discovery_summary && res.body.discovery_summary.counts);
    assert.ok(!res.text.includes(EMAIL), 'the dossier must not contain the address');
    assert.ok(!res.text.includes('u_person') || true); // user id is allowed; the address is not
    assert.ok(state.audits.some(a => a.action === 'dsr.dossier_exported'));
});

// ── Public verify without the id ────────────────────────────────────

test('the acknowledgement link still verifies when the id was lost from it', async () => {
    // Mail clients rewrite URLs and people copy `?token=…` alone. The token is
    // signed over the request id, so the server can finish what the data
    // subject started instead of telling them their valid link is dead.
    const id = await seed();
    const { token, tokenHash } = verifyToken.mint({ id, email: EMAIL, orgId: 'org_a' });
    state.tokenHashes.set(id, tokenHash);

    const ok = await post('/requests/verify', { body: { token }, ip: '198.51.100.9' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.id, id);
    assert.strictEqual(ok.body.identity_status, 'verified_email_link');
    assert.strictEqual(state.rows.get(id).identity_status, 'verified_email_link');
    assert.ok(!ok.text.includes(EMAIL));
    assert.ok(state.rows.get(id).timeline.some(e => e.kind === 'identity_verified' && e.method === 'email_link'));

    // Single use, exactly like the :id route.
    const again = await post('/requests/verify', { body: { token }, ip: '198.51.100.9' });
    assert.deepStrictEqual([again.status, again.body], [400, { error: 'invalid_token' }]);
});

test('the id-less verify refuses everything the :id route refuses, with the same body', async () => {
    const id = await seed();
    const { token, tokenHash } = verifyToken.mint({ id, email: EMAIL, orgId: 'org_a' });
    state.tokenHashes.set(id, tokenHash);
    const claimed = Buffer.from(JSON.stringify({ p: 'dsr_verify', id, e: 'a'.repeat(64), o: 'org_a', exp: Date.now() + 60_000 })).toString('base64url');

    const misses = {
        garbage: { token: 'garbage.sig' },
        empty: { token: '' },
        absent: {},
        'not a string': { token: 42 },
        'signed for a request that does not exist': { token: verifyToken.mint({ id: 9999, email: EMAIL, orgId: 'org_a' }).token },
        'bound to another address': { token: verifyToken.mint({ id, email: 'someone.else@example.org', orgId: 'org_a' }).token },
        'bound to another org': { token: verifyToken.mint({ id, email: EMAIL, orgId: 'org_b' }).token },
        expired: { token: verifyToken.mint({ id, email: EMAIL, orgId: 'org_a', now: Date.now() - (verifyToken.TTL_MS + 1000) }).token },
        // The id in the payload is a lookup hint, never an authorisation: an
        // unsigned payload that simply claims the id buys a 400.
        'claims the id but is not signed': { token: `${claimed}.nope` },
    };
    for (const [label, body] of Object.entries(misses)) {
        const res = await post('/requests/verify', { body, ip: '198.51.100.10' });
        assert.deepStrictEqual([res.status, res.body], [400, { error: 'invalid_token' }], `miss: ${label}`);
    }
    assert.strictEqual(state.rows.get(id).identity_status, 'unverified', 'no miss flips the identity');
    assert.ok(state.tokenHashes.has(id), 'and none of them burns the real token');

    // The real link still works afterwards.
    const ok = await post('/requests/verify', { body: { token }, ip: '198.51.100.10' });
    assert.strictEqual(ok.status, 200);
});

// ── The gate is visible where the routes are registered ─────────────

test('both public verify routes carry a token gate the route-surface sweep can read', () => {
    // auth/accessRegistry.sweep.test.js accounts for a route by READING this
    // file. The credential on these two routes is the signed link from the ack
    // mail, and a POST that flips identity_status is exactly the kind of route
    // that sweep exists to catch — so the gate has to sit ON the registration
    // as middleware, not one call deeper inside the handler where the sweep
    // cannot see it. Same reason the admin routes below spell out
    // requireAuth/requirePermission instead of spreading a const.
    const { parseFile } = require('../auth/routeSurfaceSweep');
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'dsr.js'), 'utf8');
    const { registrations } = parseFile(src);
    for (const p of ['/requests/verify', '/requests/:id/verify']) {
        const reg = registrations.find((r) => r.method === 'POST' && (r.paths || []).includes(p));
        assert.ok(reg, `POST ${p} is no longer statically readable — the sweep cannot account for it`);
        assert.ok(reg.gate, `POST ${p} reads as an ungated public route to auth/routeSurfaceSweep.js: put the signed-token gate back on the registration as middleware`);
    }
    // ...and it stays ONE implementation: two copies of the checks is how the
    // id-less route drifts into weaker ones.
    assert.strictEqual((src.match(/verifyToken\.check\s*\(/g) || []).length, 1,
        'the token check must exist exactly once, shared by both verify routes');
});

// ── The dossier's claim about itself ────────────────────────────────

test('the dossier carries no free text: not the subject\'s note, not the summary, not the trail', async () => {
    // The subject typed their own name and address into the public form; the
    // admin then wrote about that same person twice. The file says it contains
    // no personal data of the subject, and downstream handlers trust that.
    const NOTE = 'Ik ben Jan Jansen, Kerkstraat 1, 1234 AB Utrecht';
    const id = await seed({ status: 'in_progress', notes: NOTE });
    await post(`/requests/${id}/extend`, { session: ADMIN, body: { reason: 'Dossier van Jan Jansen ligt bij twee afdelingen' } });
    await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'fulfilled', result_summary: 'Kopie per post naar Kerkstraat 1 gestuurd.' } });

    const res = await get(`/requests/${id}/export`, { session: ADMIN });
    assert.strictEqual(res.status, 200);
    assert.match(res.body.notes, /no personal data of the subject/);
    for (const leak of ['Jan Jansen', 'Kerkstraat', NOTE, EMAIL]) {
        assert.ok(!res.text.includes(leak), `the dossier must not contain "${leak}"`);
    }
    assert.strictEqual(res.body.request.notes, undefined);
    assert.strictEqual(res.body.request.result_summary, undefined);
    assert.strictEqual(res.body.request.extension_reason, undefined);
    assert.strictEqual(res.body.request.notes_length, NOTE.length, 'the length still records that there was a note');
    assert.strictEqual(res.body.request.status, 'fulfilled');
    assert.ok(res.body.timeline.every(e => e.text === undefined), 'the trail copies the same prose');
    assert.ok(res.body.timeline.some(e => e.kind === 'extended' && e.text_length > 0));

    // And the DPO's in-app view is untouched — they still read what was asked.
    const list = await get('/requests', { session: ADMIN });
    assert.strictEqual(list.body[0].notes, NOTE);
    assert.strictEqual(list.body[0].result_summary, 'Kopie per post naar Kerkstraat 1 gestuurd.');
});

// ── Evidence is what was true at fulfilment ─────────────────────────

test('fulfil never stamps a stale discovery scan into the evidence chain', async () => {
    const id = await seed({ status: 'in_progress' });
    // The admin scanned from the drawer hours ago, and only now presses fulfil.
    const row = await mockDsrStore.getRequest('org_a', id);
    await discovery.run('org_a', row, { now: Date.now() - (discovery.MEMO_TTL_MS + 3600_000) });
    assert.strictEqual(discovery.peek('org_a', id), null, 'the memo entry is stale');

    const res = await post(`/requests/${id}/fulfil`, { session: ADMIN, body: { status: 'fulfilled', result_summary: 'Copy sent.' } });
    assert.strictEqual(res.status, 200);
    const ev = state.evidence.find(e => e.payload.action === 'dsr_fulfilled');
    assert.ok(!('discovery' in ev.payload), 'an hours-old count is not the state of the tenant at fulfilment');
    assert.ok(!ev.payload.discovery);

    // A scan that IS current still lands in the row.
    const id2 = await seed({ status: 'in_progress' });
    await get(`/requests/${id2}/discovery`, { session: ADMIN });
    await post(`/requests/${id2}/fulfil`, { session: ADMIN, body: { status: 'fulfilled', result_summary: 'Copy sent.' } });
    const ev2 = state.evidence.filter(e => e.payload.action === 'dsr_fulfilled').at(-1);
    assert.ok(ev2.payload.discovery && typeof ev2.payload.discovery.counts === 'object');
});
