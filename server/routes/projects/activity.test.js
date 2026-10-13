'use strict';

/**
 * routes/projects/activity.js on its own: the factory router served with
 * injected fakes behind a real express app and the real terminal error
 * handler. The same routes are covered through the composed router in
 * routes/projects.authz.test.js and routes/projects.resources.test.js.
 *
 * Proven:
 *   - mute and unmute write the caller's own preference, viewer+;
 *   - the activity feed pages with one extra row for `hasMore`, caps the
 *     limit at 200, and names file rows through projects/projectFiles;
 *   - typing is published as transient presence behind its own limiter, and a
 *     bus that fails answers `ok: false`, never an error;
 *   - the live stream is registered behind the role gate.
 *
 * Run: cd server && node --test routes/projects/activity.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { fakeRequireProjectRole } = require('../../testUtils/projectRoleGate');
const { makeActivityRouter } = require('./activity');

const fx = {};
function reset() {
    fx.muted = [];
    fx.activityArgs = [];
    fx.rows = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, action: 'file_added', details: { fileId: `f${i}` } }));
    fx.published = [];
    fx.busDown = false;
}
reset();

const limiterCalls = [];
const router = makeActivityRouter({
    requireProjectRole: fakeRequireProjectRole({ p1: { alice: 'owner', carol: 'viewer' } }),
    projectStore: {
        getProject: async (id) => (id === 'p1' ? { id: 'p1' } : null),
        listActivity: async (projectId, limit, offset) => {
            fx.activityArgs.push([projectId, limit, offset]);
            return fx.rows.slice(offset, offset + limit);
        },
    },
    notificationPrefsStore: {
        setMuted: async (userId, projectId, muted) => { fx.muted.push([userId, projectId, muted]); },
    },
    getUserId: (req) => req.session?.user?.id,
    perUserRateLimit: (opts) => {
        limiterCalls.push(opts);
        return function rateLimiter(req, res, next) { next(); };
    },
    projectFiles: () => ({
        nameFileActivity: async (project, rows) => rows.map((r) => ({ ...r, named: project.id })),
    }),
    projectEventBus: () => ({
        publishTransient: async (projectId, event) => {
            if (fx.busDown) throw new Error('bus down');
            fx.published.push([projectId, event]);
        },
    }),
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    req.session = who ? { user: { id: who, organizationId: 'org1' } } : {};
    next();
});
app.use('/api/projects', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
test.beforeEach(reset);

async function call(method, path, user, body) {
    await ready;
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('mute and unmute are the caller\'s own, open to every member', async () => {
    assert.deepStrictEqual((await call('PUT', '/p1/mute', 'carol', {})).body, { muted: true });
    assert.deepStrictEqual((await call('DELETE', '/p1/mute', 'carol')).body, { muted: false });
    assert.deepStrictEqual(fx.muted, [['carol', 'p1', true], ['carol', 'p1', false]]);
    assert.strictEqual((await call('PUT', '/p1/mute', 'mallory', {})).status, 404);
});

test('the activity feed pages with one extra row and names its file rows', async () => {
    const first = await call('GET', '/p1/activity?limit=2', 'carol');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.deepStrictEqual(fx.activityArgs, [['p1', 3, 0]], 'one row more than asked, to see whether there is more');
    assert.strictEqual(first.body.hasMore, true);
    assert.deepStrictEqual(first.body.items.map((r) => [r.id, r.named]), [['a0', 'p1'], ['a1', 'p1']]);

    const last = await call('GET', '/p1/activity?limit=2&offset=4', 'carol');
    assert.strictEqual(last.body.hasMore, false);
    assert.deepStrictEqual(last.body.items.map((r) => r.id), ['a4']);

    await call('GET', '/p1/activity?limit=500', 'carol');
    assert.strictEqual(fx.activityArgs.at(-1)[1], 201, 'the limit is capped at 200');
});

test('typing is transient presence behind its own limiter, and never fails a request', async () => {
    assert.strictEqual(limiterCalls.length, 1);
    assert.strictEqual(limiterCalls[0].name, 'project-typing');
    assert.strictEqual(limiterCalls[0].keyFn({ session: { user: { id: 'carol' } }, params: { id: 'p1' } }), 'carol:p1');

    const ok = await call('POST', '/p1/typing', 'carol', { conversationId: 'c1' });
    assert.deepStrictEqual(ok.body, { ok: true });
    assert.deepStrictEqual(fx.published, [['p1', { kind: 'presence.typing', actorId: 'carol', conversationId: 'c1' }]]);

    fx.busDown = true;
    const down = await call('POST', '/p1/typing', 'carol', {});
    assert.strictEqual(down.status, 200);
    assert.deepStrictEqual(down.body, { ok: false });
});

test('the live stream sits behind the role gate', () => {
    const stream = router.stack.find((l) => l.route?.path === '/:id/stream');
    assert.ok(stream, 'GET /:id/stream is registered');
    assert.strictEqual(stream.route.stack[0].name, 'requireProjectRoleMw');
});
