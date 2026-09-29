/**
 * Notification routes — authentication + ownership on the single-id mutations.
 *
 * POST /:id/read and DELETE /:id used to skip both checks that every other
 * handler in the router performs: no `req.session?.user?.id` guard, and the raw
 * path param went straight into `notificationStore.markRead(id)` /
 * `deleteNotification(id)`, whose SQL is `WHERE id = $1` with no user_id
 * predicate. The router is mounted bare (index.js: `app.use('/api/notifications',
 * …)`) with no auth middleware in front, so anyone holding a notification id —
 * leaked through a log line, a Referer, or a shared link — could silence or
 * destroy another user's alert with no session cookie at all.
 *
 * The store mutations are tenancy-scoped now too, so the handlers must pass the
 * session user as the second argument; the stubs below mirror the real store
 * and refuse an unscoped call, which is what keeps that call shape pinned.
 *
 * Run: cd server && node --test routes/notifications.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
// `rows` models the notifications table: id → owning user_id.
const fx = {
    rows: {},
    marked: [],
    deleted: [],
    // Full argument lists, so a handler that drops the tenancy scope is caught.
    markCalls: [],
    deleteCalls: [],
    queries: [],
};

// notificationStore.markRead / deleteNotification require a userId scope and
// throw without one — reproduce that here so a one-argument handler fails the
// suite instead of quietly running the pre-fix global statement.
function mustScope(fn, userId) {
    if (typeof userId !== 'string') {
        throw new TypeError(`[stub] ${fn} called without a userId scope (got ${userId === null ? 'null' : typeof userId})`);
    }
}

const MOCKS = {
    '../stores/notificationStore': {
        getNotifications: async (userId) => [{ id: 'n1', user_id: userId }],
        getUnreadCount: async () => 3,
        markAllRead: async () => 2,
        markRead: async (id, userId) => {
            mustScope('markRead', userId);
            fx.markCalls.push([id, userId]);
            fx.marked.push(id);
            return fx.rows[id] === userId;
        },
        deleteNotification: async (id, userId) => {
            mustScope('deleteNotification', userId);
            fx.deleteCalls.push([id, userId]);
            fx.deleted.push(id);
            return fx.rows[id] === userId;
        },
    },
    // The ownership predicate is a plain SELECT against the shared pool; the
    // stub answers it from `fx.rows`.
    '../db': {
        pool: {
            query: async (sql, params) => {
                fx.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                const [id, userId] = params;
                return fx.rows[id] === userId ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
            },
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:notifications-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]notifications\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./notifications');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.rows = { 'alice-note': 'alice', 'bob-note': 'bob' };
    fx.marked.length = 0;
    fx.deleted.length = 0;
    fx.markCalls.length = 0;
    fx.deleteCalls.length = 0;
    fx.queries.length = 0;
}

function dispatch({ method, url, session }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body: {}, headers: {}, session, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

const ALICE = { user: { id: 'alice' } };
const MALLORY = { user: { id: 'mallory' } };

// ═══ Anonymous callers ═══════════════════════════════════════════════

test('DELETE /:id is 401 with no session', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/alice-note', session: undefined });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'Not authenticated' });
    assert.deepStrictEqual(fx.deleted, [], 'the store was never reached');
});

test('POST /:id/read is 401 with no session', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/alice-note/read', session: undefined });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(fx.marked, []);
});

test('a session without a user id is still 401', async () => {
    resetFx();
    for (const session of [{}, { user: {} }, { user: null }]) {
        const res = await dispatch({ method: 'DELETE', url: '/alice-note', session });
        assert.strictEqual(res.statusCode, 401, `expected 401 for ${JSON.stringify(session)}`);
    }
    assert.deepStrictEqual(fx.deleted, []);
});

// ═══ Cross-user tampering ════════════════════════════════════════════

test("another user cannot delete Alice's notification", async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/alice-note', session: MALLORY });
    assert.strictEqual(res.statusCode, 404, '404, not 403 — no existence oracle');
    assert.deepStrictEqual(res.body, { error: 'Notification not found' });
    assert.deepStrictEqual(fx.deleted, [], 'the unscoped store delete never ran');
});

test("another user cannot mark Alice's notification read", async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/alice-note/read', session: MALLORY });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(fx.marked, []);
});

test('a nonexistent id gets the same 404 as someone else\'s id', async () => {
    resetFx();
    const missing = await dispatch({ method: 'DELETE', url: '/no-such-id', session: MALLORY });
    const foreign = await dispatch({ method: 'DELETE', url: '/alice-note', session: MALLORY });
    assert.strictEqual(missing.statusCode, foreign.statusCode);
    assert.deepStrictEqual(missing.body, foreign.body);
});

test('the ownership predicate is scoped by user_id', async () => {
    resetFx();
    await dispatch({ method: 'DELETE', url: '/alice-note', session: MALLORY });
    assert.strictEqual(fx.queries.length, 1);
    assert.match(fx.queries[0].sql, /user_id = \$2/, 'the SELECT carries a user_id predicate');
    assert.deepStrictEqual(fx.queries[0].params, ['alice-note', 'mallory']);
});

// ═══ The owner still gets the feature ════════════════════════════════

test('the owner can mark her own notification read', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/alice-note/read', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
    assert.deepStrictEqual(fx.marked, ['alice-note']);
});

test('the owner can delete her own notification', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/alice-note', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
    assert.deepStrictEqual(fx.deleted, ['alice-note']);
});

test('both handlers pass the session user to the store as a tenancy scope', async () => {
    // The ownership SELECT above is not the only line of defence: the store
    // statement itself must carry `AND user_id = $2`, which it only can when
    // the handler supplies the second argument. A one-argument call here is a
    // silent return to the global `WHERE id = $1` statement.
    resetFx();
    await dispatch({ method: 'POST', url: '/alice-note/read', session: ALICE });
    await dispatch({ method: 'DELETE', url: '/alice-note', session: ALICE });
    assert.deepStrictEqual(fx.markCalls, [['alice-note', 'alice']]);
    assert.deepStrictEqual(fx.deleteCalls, [['alice-note', 'alice']]);
});

// ═══ The already-guarded handlers keep working ═══════════════════════

test('GET / and /unread-count and POST /read-all are unchanged', async () => {
    resetFx();
    const list = await dispatch({ method: 'GET', url: '/', session: ALICE });
    assert.strictEqual(list.statusCode, 200);
    assert.strictEqual(list.body.notifications[0].user_id, 'alice');

    const count = await dispatch({ method: 'GET', url: '/unread-count', session: ALICE });
    assert.strictEqual(count.statusCode, 200);
    assert.strictEqual(count.body.count, 3);

    const all = await dispatch({ method: 'POST', url: '/read-all', session: ALICE });
    assert.strictEqual(all.statusCode, 200);
    assert.deepStrictEqual(all.body, { success: true, marked: 2 });

    const anon = await dispatch({ method: 'GET', url: '/', session: undefined });
    assert.strictEqual(anon.statusCode, 401);
});
