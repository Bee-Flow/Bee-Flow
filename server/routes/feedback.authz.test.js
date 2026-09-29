/**
 * /api/feedback — authorization tests.
 *
 * WHY THIS FILE EXISTS: GET / and GET /summary carried the comment "(admin)"
 * but no gate at all. The capability middleware mounted in front of them
 * (index.js) calls next() for unauthenticated callers by design — it defers to
 * an auth gate downstream, and on this router there was none. Meanwhile
 * feedbackStore.getFeedback is `SELECT * FROM message_feedback` with no tenant
 * predicate, and those rows carry conversation_snapshot: the verbatim,
 * unencrypted text of every message in a conversation a user chose to attach.
 * `limit` reached parseInt straight from the query string, unclamped.
 *
 * The net effect, found by the 2026-08-10 pentest, was that an anonymous
 * request returned chat transcripts belonging to every tenant. On a
 * zero-knowledge product that is the most serious kind of finding, so the
 * denial is pinned here rather than left to review.
 *
 * Run: node --test routes/feedback.authz.test.js
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

// A row shaped like the real thing: the snapshot is what must never escape.
const SECRET_SNAPSHOT = JSON.stringify([
    { role: 'user', content: 'PRIVATE-TRANSCRIPT-CANARY' },
]);

const capturedLimits = [];

mock('../db', {
    exec: async () => ({ rows: [], rowCount: 0 }),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});

mock('../stores/feedbackStore', {
    getFeedback: async (_filters, limit) => {
        capturedLimits.push(limit);
        return [{
            id: 'fb1',
            organization_id: 'some-other-tenant',
            user_id: 'victim',
            rating: 'up',
            conversation_snapshot: SECRET_SNAPSHOT,
        }];
    },
    getFeedbackSummary: async () => ({ total: 1, thumbs_up: 1, thumbs_down: 0 }),
    saveFeedback: async () => ({ id: 'fb-new' }),
});

mock('../stores/userStore', { getUser: async () => null });

const express = require('express');
const feedbackRouter = require('./feedback');

let server, baseUrl;
let session = null;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session; next(); });
    app.use('/api/feedback', feedbackRouter);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

async function call(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
        body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
}

const PLATFORM_ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'admin1', role: 'admin' } };
const ORG_ADMIN = {
    isAuthenticated: true,
    user: { id: 'oa', role: 'user', orgRole: 'org_admin', organizationId: 'my-org' },
};

test('anonymous callers cannot read the global feedback list', async () => {
    session = null;
    for (const path of ['/api/feedback', '/api/feedback/summary']) {
        const res = await call('GET', path);
        assert.strictEqual(res.status, 401, `${path} must reject anonymous callers`);
        assert.ok(
            !res.text.includes('PRIVATE-TRANSCRIPT-CANARY'),
            `${path} leaked a conversation transcript to an anonymous caller`,
        );
    }
});

test('an org admin cannot read the cross-tenant list', async () => {
    // The global endpoints are unfiltered. An org admin's legitimate view is
    // /api/feedback/org, which scopes by organisation.
    session = ORG_ADMIN;
    for (const path of ['/api/feedback', '/api/feedback/summary']) {
        const res = await call('GET', path);
        assert.strictEqual(res.status, 403, `${path} must not serve an org admin`);
        assert.ok(!res.text.includes('PRIVATE-TRANSCRIPT-CANARY'));
    }
});

test('anonymous callers cannot write feedback rows', async () => {
    session = null;
    const res = await call('POST', '/api/feedback', {
        rating: 'up',
        conversationSnapshot: [{ role: 'user', content: 'injected' }],
    });
    assert.strictEqual(res.status, 401);
});

test('a platform admin can still read, and limit is clamped', async () => {
    session = PLATFORM_ADMIN;
    capturedLimits.length = 0;

    const ok = await call('GET', '/api/feedback');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(capturedLimits.at(-1), 200, 'default page size should be unchanged');

    // Unbounded `limit` was how a single request could pull the whole table.
    await call('GET', '/api/feedback?limit=1000000');
    assert.strictEqual(capturedLimits.at(-1), 500, 'limit must be clamped to the maximum');

    await call('GET', '/api/feedback?limit=50');
    assert.strictEqual(capturedLimits.at(-1), 50, 'a sane limit should pass through');

    // Refused, not read as "the default": a limit that is not a number is a
    // question the route cannot answer, and the store is never reached.
    const before = capturedLimits.length;
    const bad = await call('GET', '/api/feedback?limit=notanumber');
    assert.strictEqual(bad.status, 400, 'an unparseable limit is refused');
    assert.strictEqual(capturedLimits.length, before, 'and the store is not asked');
});
