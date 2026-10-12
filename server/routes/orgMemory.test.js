/**
 * Route-level tests: organisation memory settings (routes/orgMemory.js).
 *
 * What this pins:
 *   - only an org admin may read, write or clear; a member gets 403;
 *   - GET returns settings and counts, never memory content;
 *   - PUT is a strict body (a misspelt field is refused), clamps maxPerUser and
 *     writes an audit entry;
 *   - clear needs {"confirm":"DELETE"}, deletes for THAT org only and audits.
 *
 * Run: node --test routes/orgMemory.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const { createOrgMemorySettings } = require('../core/memory/memoryPolicy');
const { createOrgMemoryRouter } = require('./orgMemory');

const blobs = {};
const audits = [];
const cleared = [];
const sensitiveCleared = [];
const optInDeletes = [];

// The real policy logic (defaults, clamping, merging) over an in-memory store.
const policy = createOrgMemorySettings({
    async getConfig(key) { return blobs[key] !== undefined ? blobs[key] : null; },
    async setConfig(key, value) { blobs[key] = value; return true; },
});

const router = createOrgMemoryRouter({
    requireAuth(req, res, next) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Unauthenticated' });
        return next();
    },
    async isOrgAdmin(req, orgId) {
        return req?.session?.user?.orgRole === 'org_admin' && req?.session?.user?.organizationId === orgId;
    },
    ...policy,
    memoryStore: {
        async countOrgMemoryStats(orgId) { return { activeMemories: 7, users: 3, orgId }; },
        async deleteMemoriesForOrg(orgId) { cleared.push(orgId); return 7; },
    },
    memoryQueries: {
        async deleteSensitiveForOrg(orgId) { sensitiveCleared.push(orgId); return 4; },
        async listOrgUserIds() { return ['u1', 'u2', 'u3']; },
    },
    configStore: { async deleteConfig(key) { optInDeletes.push(key); return true; } },
    sensitiveOptInKey: (id) => `memory_sensitive_opt_in_user_${id}`,
    userStore: {
        async logAccessAudit(...args) { audits.push(args); },
    },
});

const app = express();
app.use(express.json());
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/org-memory', router);
app.use(terminalErrorHandler);
let server;

before(() => { server = app.listen(0); });
after(() => { server?.close(); });

function request(method, pathname, body = null) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
            method, headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const ORG = 'org_test';
const URL_ = `/api/org-memory/${ORG}`;
const ADMIN = { isAuthenticated: true, user: { id: 'u_admin', organizationId: ORG, orgRole: 'org_admin' } };
const MEMBER = { isAuthenticated: true, user: { id: 'u_member', organizationId: ORG, orgRole: 'member' } };
const OTHER_ADMIN = { isAuthenticated: true, user: { id: 'u_o', organizationId: 'org_other', orgRole: 'org_admin' } };

beforeEach(() => {
    for (const k of Object.keys(blobs)) delete blobs[k];
    audits.length = 0;
    cleared.length = 0;
    sensitiveCleared.length = 0;
    optInDeletes.length = 0;
    currentSession = ADMIN;
});

test('GET returns the defaults and counts only', async () => {
    const res = await request('GET', URL_);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.settings, { enabled: true, sensitiveOptInAllowed: false, maxPerUser: 1000 });
    assert.strictEqual(res.body.stats.activeMemories, 7);
    assert.strictEqual(res.body.stats.users, 3);
    assert.ok(!('memories' in res.body) && !('items' in res.body), 'no memory content');
});

test('a member, an admin of another org, and a signed-out caller are refused on all three routes', async () => {
    for (const session of [MEMBER, OTHER_ADMIN]) {
        currentSession = session;
        assert.strictEqual((await request('GET', URL_)).status, 403);
        assert.strictEqual((await request('PUT', URL_, { enabled: false })).status, 403);
        assert.strictEqual((await request('POST', `${URL_}/clear`, { confirm: 'DELETE' })).status, 403);
    }
    currentSession = null;
    assert.strictEqual((await request('GET', URL_)).status, 401);
    assert.deepStrictEqual(blobs, {}, 'nothing was written');
    assert.deepStrictEqual(cleared, [], 'nothing was cleared');
    assert.deepStrictEqual(audits, []);
});

test('PUT saves, clamps maxPerUser, round-trips and writes an audit entry', async () => {
    const put = await request('PUT', URL_, { enabled: false, sensitiveOptInAllowed: true, maxPerUser: 5 });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(put.body.settings, { enabled: false, sensitiveOptInAllowed: true, maxPerUser: 50 });
    assert.deepStrictEqual(blobs[`org_memory_${ORG}`], put.body.settings);
    assert.deepStrictEqual((await request('GET', URL_)).body.settings, put.body.settings);

    assert.strictEqual(audits.length, 1);
    const [action, targetType, targetId, actor, before, after, orgId] = audits[0];
    assert.deepStrictEqual([action, targetType, targetId, actor, orgId], ['org.memory.update', 'organization', ORG, 'u_admin', ORG]);
    assert.strictEqual(before.enabled, true);
    assert.strictEqual(after.enabled, false);
});

test('PUT with a partial body keeps the other fields', async () => {
    await request('PUT', URL_, { maxPerUser: 200 });
    const res = await request('PUT', URL_, { enabled: false });
    assert.deepStrictEqual(res.body.settings, { enabled: false, sensitiveOptInAllowed: false, maxPerUser: 200 });
});

test('PUT refuses a misspelt field, a string for a boolean and a non-number cap, writing nothing', async () => {
    for (const body of [{ enabeld: false }, { enabled: 'false' }, { maxPerUser: 'lots' }, { enabled: false, extra: 1 }]) {
        const res = await request('PUT', URL_, body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(blobs, {});
    assert.deepStrictEqual(audits, []);
});

test('clear without the confirmation word deletes nothing', async () => {
    for (const body of [undefined, {}, { confirm: 'delete' }, { confirm: true }, { confirm: 'DELETE', all: true }]) {
        const res = await request('POST', `${URL_}/clear`, body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(cleared, []);
    assert.deepStrictEqual(audits, []);
});

test('clear with {"confirm":"DELETE"} deletes for this org only and audits it', async () => {
    const res = await request('POST', `${URL_}/clear`, { confirm: 'DELETE' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { deleted: 7 });
    assert.deepStrictEqual(cleared, [ORG]);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0][0], 'org.memory.clear');
    assert.deepStrictEqual(audits[0][5], { deleted: 7 });
});

test('PUT turning sensitiveOptInAllowed off deletes the org\'s art. 9 memories and reports the count', async () => {
    await request('PUT', URL_, { sensitiveOptInAllowed: true });
    assert.deepStrictEqual(sensitiveCleared, [], 'turning it on deletes nothing');
    audits.length = 0;
    const res = await request('PUT', URL_, { sensitiveOptInAllowed: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.sensitiveOptInAllowed, false);
    assert.strictEqual(res.body.deletedSensitive, 4);
    assert.deepStrictEqual(sensitiveCleared, [ORG]);
    assert.deepStrictEqual(optInDeletes.sort(), ['u1', 'u2', 'u3'].map((id) => `memory_sensitive_opt_in_user_${id}`),
        'every member\'s opt-in is withdrawn, so a later re-enable needs fresh consent');
    assert.deepStrictEqual(res.body.stats, { activeMemories: 7, users: 3, orgId: ORG }, 'the PUT answers with fresh stats');
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0][5].deletedSensitive, 4);
    assert.strictEqual(audits[0][4].sensitiveOptInAllowed, true);
});

test('PUT that leaves sensitiveOptInAllowed false or unchanged deletes nothing', async () => {
    const first = await request('PUT', URL_, { maxPerUser: 100 });
    assert.strictEqual(first.body.deletedSensitive, 0);
    await request('PUT', URL_, { sensitiveOptInAllowed: true });
    const same = await request('PUT', URL_, { sensitiveOptInAllowed: true, maxPerUser: 300 });
    assert.strictEqual(same.body.deletedSensitive, 0);
    assert.deepStrictEqual(sensitiveCleared, []);
    assert.deepStrictEqual(optInDeletes, [], 'opt-ins stay when nothing was withdrawn');
});

test('a member cannot trigger the sensitive deletion', async () => {
    await request('PUT', URL_, { sensitiveOptInAllowed: true });
    currentSession = MEMBER;
    assert.strictEqual((await request('PUT', URL_, { sensitiveOptInAllowed: false })).status, 403);
    assert.deepStrictEqual(sensitiveCleared, []);
});
