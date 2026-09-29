/**
 * Route tests for GET /api/transcriptions/tags (routes/transcriptions/tags.js).
 *
 * The chips this feeds are a FILTER over other people's meetings, so the test
 * that matters is the ACL one: the predicate must be the list's predicate,
 * built from the SESSION's user id, and an empty org/group set must never
 * reach Postgres as `ANY('{}'::text[])`. The rest pins the tolerance rules
 * (a non-array `tags`, a non-string element, a duplicate tag inside one note)
 * and the response shape the client reads.
 *
 * Harness: the MOCKS table + Module._resolveFilename idiom of
 * routes/cmsAnalytics.test.js, so the REAL router runs on a real HTTP server
 * while `db`, `auth/permissions` and `./shared` are stand-ins — no pool, no
 * Postgres.
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions/tags.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('node:module');

// ── Stand-ins ───────────────────────────────────────────────────────

/** Every getAll the router makes: { sql, params }. */
let queries = [];
/** What getAll answers, or throws when it is an Error. */
let dbAnswer = [];

const mockDb = {
    getAll: async (sql, params) => {
        queries.push({ sql, params });
        if (dbAnswer instanceof Error) throw dbAnswer;
        return dbAnswer;
    },
};

/** The real requireAuth 401s an anonymous request; this one does the same. */
const mockPermissions = {
    requireAuth: (req, res, next) => {
        if (!req.session?.user?.id) return res.status(401).json({ error: 'Authentication required' });
        return next();
    },
};

let accessContext = { orgIds: [], userGroupIds: [], isSuperAdmin: false };
const mockShared = { resolveAccessContext: async () => accessContext };

const MOCKS = {
    '../../db': mockDb,
    '../../auth/permissions': mockPermissions,
    './shared': mockShared,
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:transcription-tags:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const tagsRouter = require('./tags');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;
let sessionUser = { id: 'u1' };

async function get(path = '/api/transcriptions/tags') {
    const res = await fetch(`${baseUrl}${path}`);
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
}

test.before(async () => {
    const app = express();
    app.use((req, _res, next) => {
        req.session = sessionUser ? { isAuthenticated: true, user: sessionUser } : {};
        next();
    });
    app.use('/api/transcriptions', tagsRouter);
    // `next(err)` is not `next()`: a request schema refuses by handing the
    // error on, so the terminal handler sits behind the router exactly as it
    // does in index.js.
    app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    if (server) await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
    queries = [];
    dbAnswer = [];
    sessionUser = { id: 'u1' };
    accessContext = { orgIds: [], userGroupIds: [], isSuperAdmin: false };
});

// ── The answer the client reads ─────────────────────────────────────

test('answers [{tag, count}] in the order Postgres returned, counts as numbers', async () => {
    dbAnswer = [
        { tag: 'dataweging', count: 4 },
        { tag: 'spelersmonitor', count: '3' },   // pg can hand back a string for a bigint
    ];
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [
        { tag: 'dataweging', count: 4 },
        { tag: 'spelersmonitor', count: 3 },
    ]);
});

test('no rows → [], never null (an empty vocabulary is not an error)', async () => {
    dbAnswer = null;
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, []);
});

test('a failing query is a 500 that leaks no SQL', async () => {
    dbAnswer = new Error('relation "transcriptions" does not exist');
    const res = await get();
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'Failed to list tags' });
});

// ── The ACL: this is the security surface ───────────────────────────

test('anonymous is refused before any query runs', async () => {
    sessionUser = null;
    const res = await get();
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0, 'requireAuth must gate the handler');
});

test('own rows + legacy shares only, when the caller is in no org', async () => {
    await get();
    const { sql, params } = queries[0];
    assert.match(sql, /user_id = \$1/);
    assert.match(sql, /shared_with @> \$2::jsonb/);
    assert.ok(!/is_published/.test(sql), 'no org clause without an org');
    assert.deepEqual(params, ['u1', JSON.stringify(['u1'])]);
    // The empty-set trap the store documents: never ANY('{}') / ?| ARRAY[].
    assert.ok(!/ANY\('\{\}'/.test(sql), sql);
    assert.ok(!/ARRAY\[\]/.test(sql), sql);
});

test('an org member without groups sees org-published rows shared with nobody in particular', async () => {
    accessContext = { orgIds: ['orgA'], userGroupIds: [], isSuperAdmin: false };
    await get();
    const { sql, params } = queries[0];
    assert.match(sql, /is_published = true AND organization_id = ANY\(\$3::text\[\]\) AND shared_groups = '\[\]'::jsonb/);
    assert.ok(!/\?\|/.test(sql), 'no group predicate without groups');
    assert.deepEqual(params, ['u1', JSON.stringify(['u1']), ['orgA']]);
});

test('an org member WITH groups also sees rows shared to one of those groups', async () => {
    accessContext = { orgIds: ['orgA', 'orgB'], userGroupIds: ['g1'], isSuperAdmin: false };
    await get();
    const { sql, params } = queries[0];
    assert.match(sql, /shared_groups = '\[\]'::jsonb OR shared_groups \?\| \$4::text\[\]/);
    assert.deepEqual(params, ['u1', JSON.stringify(['u1']), ['orgA', 'orgB'], ['g1']]);
});

test('the predicate is built from the SESSION user, not from anything the caller sends', async () => {
    // The route reads NOTHING from the query string, and now says so: a
    // parameter shaped like an override is refused rather than accepted and
    // ignored, so there is no longer any way to send one at all.
    sessionUser = { id: 'u1' };
    const res = await get('/api/transcriptions/tags?userId=u2&orgIds=orgZ');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.code, 'invalid_request');
    assert.deepEqual(queries, [], 'a refused request must not reach the database');

    // And the predicate a real request builds still comes from the session.
    await get();
    assert.deepEqual(queries[0].params, ['u1', JSON.stringify(['u1'])]);
});

test('a super admin counts over every note, with no ACL clause and no params', async () => {
    accessContext = { orgIds: [], userGroupIds: [], isSuperAdmin: true };
    await get();
    const { sql, params } = queries[0];
    assert.ok(!/user_id = \$1/.test(sql), 'super admins list everything, so they count everything');
    assert.deepEqual(params, []);
});

// ── Tolerance and shape of the aggregate ────────────────────────────

test('a non-array `tags` counts as no tags instead of throwing', async () => {
    await get();
    assert.match(queries[0].sql, /jsonb_typeof\(tags\) = 'array'/);
    assert.match(queries[0].sql, /ELSE '\[\]'::jsonb END/);
});

test('only string elements become chips — a number in the array is not a filter anyone can match', async () => {
    await get();
    assert.match(queries[0].sql, /jsonb_typeof\(tag_of\.value\) = 'string'/);
    assert.match(queries[0].sql, /#>> '\{\}'\) <> ''/);
});

test('a chip counts NOTES, so one note tagged twice still counts once', async () => {
    await get();
    assert.match(queries[0].sql, /COUNT\(DISTINCT transcriptions\.id\)::int AS count/);
});

test('most-used first, alphabetical inside a tie, and a bounded number of chips', async () => {
    await get();
    assert.match(queries[0].sql, /ORDER BY count DESC, tag ASC/);
    assert.match(queries[0].sql, /LIMIT 200/);
});

// ── buildListAcl on its own ─────────────────────────────────────────

test('buildListAcl: the ORs are the whole predicate and the params line up with them', () => {
    const { buildListAcl } = tagsRouter;
    const bare = buildListAcl('u9');
    assert.equal(bare.where, "user_id = $1 OR shared_with @> $2::jsonb");
    assert.deepEqual(bare.params, ['u9', '["u9"]']);

    const withGroups = buildListAcl('u9', { orgIds: ['o1'], userGroupIds: ['g1', 'g2'] });
    assert.equal(withGroups.params.length, 4);
    assert.deepEqual(withGroups.params[2], ['o1']);
    assert.deepEqual(withGroups.params[3], ['g1', 'g2']);
    // Every $n in the predicate has a param behind it.
    const highest = Math.max(...[...withGroups.where.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(highest, withGroups.params.length);
});
