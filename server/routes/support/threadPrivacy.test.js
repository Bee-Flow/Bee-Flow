/**
 * An anonymous support submission is never linked to an account by its e-mail
 * address, and a requester (token holder) reading a thread sees an allow-listed
 * projection: no account id, organisation, name, role, IP or user agent.
 *
 * Run: cd server && node --test routes/support/threadPrivacy.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'x'.repeat(40);

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const tokens = require('../../stores/supportStore/requesterTokens');
const supportStore = require('../../stores/supportStore');
const userStore = require('../../stores/userStore');

const FULL_ROW = {
    id: 'th-9', subject: 'Help', status: 'open', priority: 'normal', source: 'marketing',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_message_at: null,
    requester_email: 'victim@example.org', requester_user_id: 'u-victim', requester_name: 'Victim Name',
    organization_id: 'org-b', requester_org_name: 'Org B', requester_org_role: 'admin',
    requester_ip: '10.0.0.1', requester_ua: 'UA', assignee_user_id: 'staff-1', inbox_id: 'ib-1',
};

/** @type {any[]} */
const created = [];
let emailLookups = 0;
const SENTINEL = new Error('stop after createThread');
const stubs = [
    [supportStore, 'getThread', async (/** @type {string} */ id) => (id === 'th-9' ? { ...FULL_ROW } : null)],
    [supportStore, 'getThreadMessages', async () => []],
    [supportStore, 'createThread', async (/** @type {any} */ args) => { created.push(args); throw SENTINEL; }],
    [userStore, 'getUserByEmail', async () => { emailLookups += 1; return { id: 'u-victim', organizationId: 'org-b', orgRole: 'admin', displayName: 'Victim Name' }; }],
    [userStore, 'getOrganization', async () => ({ name: 'Org B' })],
];
const originals = stubs.map(([obj, key]) => [obj, key, obj[key]]);
for (const [obj, key, value] of stubs) obj[key] = value;
test.after(() => { for (const [obj, key, value] of originals) obj[key] = value; });

const threads = require('./threads');

const router = express.Router();
threads.registerThreadRoutes(router);
const app = express();
app.use(express.json());
app.use('/api/support', router);
app.use((/** @type {any} */ err, /** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ _next) => {
    res.status(err === SENTINEL ? 599 : 500).json({ error: 'x' });
});

/** @type {http.Server} */
let server;
let base = '';
test.before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    base = `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}`;
});
test.after(() => server.close());

test('an anonymous submission with a registered address is not linked to that account', async () => {
    created.length = 0;
    const res = await fetch(`${base}/api/support/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'Question', message: 'Hello there, a question.', email: 'victim@example.org', source: 'marketing' }),
    });
    assert.strictEqual(res.status, 599, 'the route reached createThread');
    assert.strictEqual(created.length, 1);
    const args = created[0];
    assert.strictEqual(args.requesterUserId, null);
    assert.strictEqual(args.organizationId, null);
    assert.strictEqual(args.requesterOrgRole, null);
    assert.strictEqual(args.requesterOrgName, null);
    assert.strictEqual(args.requesterName, null);
    assert.strictEqual(emailLookups, 0, 'no account lookup by an unverified address');
});

test('a token holder reads an allow-listed projection of the thread', async () => {
    const token = tokens.buildAccessToken('th-9', 'victim@example.org');
    const res = await fetch(`${base}/api/support/threads/th-9?token=${token}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.viewerIsStaff, false);
    assert.strictEqual(body.thread.id, 'th-9');
    assert.strictEqual(body.thread.subject, 'Help');
    assert.strictEqual(body.thread.status, 'open');
    for (const key of ['requester_user_id', 'organization_id', 'requester_name', 'requester_org_name',
        'requester_org_role', 'requester_ip', 'requester_ua', 'requester_email', 'assignee_user_id', 'inbox_id']) {
        assert.ok(!(key in body.thread), `${key} is not in the requester view`);
    }
});
