/**
 * /api/support/mailbox — disconnecting the email box from the company inbox.
 *
 * Bee Flow's own Customer Support panel (admin dashboard → Support) has no
 * mailbox connector: it is fed by the marketing form and by in-app tickets.
 * Mail-sourced threads reach it only as residue of a Support-studio mailbox
 * that was removed while deleteInbox still detached its threads
 * (inbox_id = NULL, which is precisely how this inbox is defined). These
 * endpoints let a super-admin cut that mailbox loose and purge what it left.
 *
 * Pinned here because the operation is destructive and unrecoverable:
 *   - reading the status needs admin_support, purging needs super-admin;
 *   - the purge selector stays narrow (mail-sourced, company inbox only), so a
 *     disconnect can never take the marketing-form or in-app tickets with it.
 *
 * Run: node --test routes/support.mailbox.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// Who the request is: flipped per case before each call.
let session = null;
let hasAdminSupport = false;

const purgeCalls = [];
const auditCalls = [];

mock('../db', {
    exec: async () => ({ rows: [], rowCount: 0 }),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
});

mock('../stores/supportStore', {
    initDB: async () => {},
    getCompanyMailboxSummary: async () => ({
        count: 11, activeCount: 9,
        firstAt: '2026-08-07T08:31:18.314Z', lastAt: '2026-08-07T10:21:59.622Z',
    }),
    deleteMailboxThreads: async (selector) => { purgeCalls.push(selector); return 11; },
    recordAuditEvent: async (evt) => { auditCalls.push(evt); return null; },
    listThreads: async () => [],
    countThreadsByStatus: async () => ({}),
});

mock('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
mock('../stores/userStore', { getUserById: async () => null });
mock('../stores/notificationStore', { createNotification: async () => {} });
mock('../services/supportAiResponder', { runAiAutoResponder: async () => {} });
mock('../support/emails', {
    sendThreadCreatedEmail: async () => {}, sendAiReplyEmail: async () => {},
    sendStaffReplyEmail: async () => {}, sendThreadResolvedEmail: async () => {},
    sendOrNotifyStaff: async () => {},
});
mock('../support/staffAccess', { hasAdminSupport: async () => hasAdminSupport });
mock('../auth', {
    resolveUserOrgIds: async () => [],
    isSuperAdmin: (req) => req.session?.user?.role === 'admin',
});

const express = require('express');
const supportRouter = require('../routes/support');

let server, base;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = session; next(); });
    app.use('/api/support', supportRouter);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

async function call(method, path) {
    const res = await fetch(`${base}${path}`, { method });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
}

const STAFF = { user: { id: 'u-staff', role: 'user' } };
const SUPER = { user: { id: 'u-admin', role: 'admin' } };

test('GET /mailbox is refused without admin_support', async () => {
    session = STAFF; hasAdminSupport = false;
    const { status } = await call('GET', '/api/support/mailbox');
    assert.strictEqual(status, 403);
});

test('GET /mailbox reports the mailbox residue for support staff', async () => {
    session = STAFF; hasAdminSupport = true;
    const { status, body } = await call('GET', '/api/support/mailbox');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.mailbox.connected, true);
    assert.strictEqual(body.mailbox.count, 11);
    assert.strictEqual(body.mailbox.activeCount, 9);
});

test('POST /mailbox/disconnect is refused for support staff who are not super-admin', async () => {
    session = STAFF; hasAdminSupport = true;
    purgeCalls.length = 0;
    const { status } = await call('POST', '/api/support/mailbox/disconnect');
    assert.strictEqual(status, 403);
    assert.strictEqual(purgeCalls.length, 0, 'a 403 must not delete anything');
});

test('POST /mailbox/disconnect purges only the company inbox mail threads', async () => {
    session = SUPER; hasAdminSupport = true;
    purgeCalls.length = 0; auditCalls.length = 0;

    const { status, body } = await call('POST', '/api/support/mailbox/disconnect');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.removed, 11);

    assert.strictEqual(purgeCalls.length, 1);
    // Narrow selector: mail-sourced threads in the company inbox, nothing else.
    assert.deepStrictEqual(purgeCalls[0], { companyMailbox: true });

    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].action, 'inbox_disconnected');
    assert.strictEqual(auditCalls[0].payload.scope, 'company');
    assert.strictEqual(auditCalls[0].payload.purgedThreads, 11);
    assert.strictEqual(auditCalls[0].actorUserId, 'u-admin');
});
