/**
 * GET /api/transcriptions/tags — the tag vocabulary with counts, scoped to
 * what the caller may read (Bee Flow Builder redesign, Sep 2026, Track M1).
 *
 * Pinned here:
 *   - the response is a bare `[{ tag, count }]`, counts as numbers;
 *   - a normal user's query carries the LIST read-ACL (own rows, legacy
 *     per-user shares, published-to-my-org rows filtered by group) — a chip
 *     must never name a tag on a note the caller could not open;
 *   - an empty orgIds / userGroupIds never reaches Postgres as an empty
 *     array parameter (the `pg` trap the store documents);
 *   - a super admin counts over everything, unfiltered, as they list
 *     everything;
 *   - a non-array `tags` column counts as no tags (one bad row cannot take
 *     the chips down for everyone).
 *
 * Drives the REAL sub-router with require-cache-stubbed collaborators and the
 * dispatch harness of transcriptions.payload.test.js — no HTTP, no DB.
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions.tags.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const db = { calls: [], rows: [] };
let orgIds = new Set(['org-1']);
let groups = [];

stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => orgIds });
stub('../stores/userStore', { getUser: async () => ({ groups }), getAllGroups: async () => [] });
stub('../stores/summaryTemplateStore', { resolveDefaultPrompt: async () => null, resolveDefaultTemplate: async () => null });
stub('../db', {
    getAll: async (sql, params) => { db.calls.push({ sql, params }); return db.rows; },
    getOne: async () => null,
    run: async () => ({ rowCount: 0 }),
    exec: async () => {},
});

const router = require('./transcriptions/tags');
const { buildListAcl } = router;

function dispatch({ method = 'GET', url, user = 'owner-1' }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: user } },
            get(n) { return this.headers[String(n).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

test.beforeEach(() => {
    db.calls = [];
    db.rows = [];
    orgIds = new Set(['org-1']);
    groups = [];
});

test('answers a bare array of { tag, count } with numeric counts, in the order Postgres returned', async () => {
    db.rows = [{ tag: 'dataweging', count: '4' }, { tag: 'spelersmonitor', count: 3 }];
    const res = await dispatch({ url: '/tags' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, [{ tag: 'dataweging', count: 4 }, { tag: 'spelersmonitor', count: 3 }]);
});

test('a normal user counts over the list read-ACL: own, shared-with-me, published-to-my-org (group-filtered)', async () => {
    groups = ['g1', 'g2'];
    await dispatch({ url: '/tags', user: 'u-7' });
    assert.strictEqual(db.calls.length, 1);
    const { sql, params } = db.calls[0];
    // The tag source pinned here followed the route: stage M1's review pass
    // (COMPLETED-STAGES.md stage 12, landed in ad198f2) replaced
    // `jsonb_array_elements_text(...) AS tag_of(tag)` + `GROUP BY tag_of.tag`
    // with `jsonb_array_elements(...) AS tag_of(value)` grouped on the
    // extracted text, so non-STRING elements can be filtered out (a number in
    // the array would render a chip no note's `tags.includes(tag)` can match)
    // and one note tagged twice counts once (COUNT(DISTINCT id)). The
    // colocated transcriptions/tags.test.js pins that aggregate in full; this
    // match only anchors that the ACL below sits on the one real query.
    assert.match(sql, /jsonb_array_elements\(CASE WHEN jsonb_typeof\(tags\) = 'array' THEN tags ELSE '\[\]'::jsonb END\)/);
    assert.match(sql, /WHERE \(user_id = \$1 OR shared_with @> \$2::jsonb OR \(is_published = true AND organization_id = ANY\(\$3::text\[\]\) AND \(shared_groups = '\[\]'::jsonb OR shared_groups \?\| \$4::text\[\]\)\)\)/);
    assert.match(sql, /GROUP BY \(tag_of\.value #>> '\{\}'\)/);
    assert.match(sql, /ORDER BY count DESC, tag ASC/);
    assert.match(sql, /LIMIT 200/);
    assert.deepStrictEqual(params, ['u-7', JSON.stringify(['u-7']), ['org-1'], ['g1', 'g2']]);
});

test('no groups → the org clause narrows to org-wide publications, and no empty array parameter is sent', async () => {
    groups = [];
    await dispatch({ url: '/tags', user: 'u-7' });
    const { sql, params } = db.calls[0];
    assert.match(sql, /AND shared_groups = '\[\]'::jsonb\)/);
    assert.doesNotMatch(sql, /\?\|/);
    assert.deepStrictEqual(params, ['u-7', JSON.stringify(['u-7']), ['org-1']]);
});

test('no org at all → only own rows and legacy per-user shares are counted', async () => {
    orgIds = new Set();
    await dispatch({ url: '/tags', user: 'u-7' });
    const { sql, params } = db.calls[0];
    assert.match(sql, /WHERE \(user_id = \$1 OR shared_with @> \$2::jsonb\)/);
    assert.doesNotMatch(sql, /is_published/);
    assert.deepStrictEqual(params, ['u-7', JSON.stringify(['u-7'])]);
});

test('a super admin (resolveUserOrgIds → null) counts over every note, unfiltered', async () => {
    orgIds = null;
    await dispatch({ url: '/tags', user: 'admin' });
    const { sql, params } = db.calls[0];
    assert.doesNotMatch(sql, /user_id/);
    assert.doesNotMatch(sql, /is_published/);
    assert.deepStrictEqual(params, []);
});

test('buildListAcl mirrors the store predicate shape for every combination', () => {
    assert.deepStrictEqual(buildListAcl('u', {}), {
        where: 'user_id = $1 OR shared_with @> $2::jsonb',
        params: ['u', '["u"]'],
    });
    assert.deepStrictEqual(buildListAcl('u', { orgIds: ['o'] }).params, ['u', '["u"]', ['o']]);
    assert.deepStrictEqual(buildListAcl('u', { orgIds: ['o'], userGroupIds: ['g'] }).params, ['u', '["u"]', ['o'], ['g']]);
    // An empty group list is the same as none: no `?|` clause, no empty array param.
    assert.deepStrictEqual(buildListAcl('u', { orgIds: ['o'], userGroupIds: [] }), buildListAcl('u', { orgIds: ['o'] }));
});

test('a database failure answers 500 with a generic message, never the SQL error', async () => {
    const dbPath = require.resolve('../db');
    const real = require.cache[dbPath].exports;
    require.cache[dbPath].exports = { ...real, getAll: async () => { throw new Error('relation "transcriptions" does not exist'); } };
    // The router captured `getAll` at require time; re-require through a fresh cache entry.
    delete require.cache[require.resolve('./transcriptions/tags')];
    const fresh = require('./transcriptions/tags');
    const res = await new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/tags', query: {}, headers: {}, session: { isAuthenticated: true, user: { id: 'u' } }, get() {}, setTimeout() {} };
        const r = {
            statusCode: 200, body: undefined,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); return this; }, setTimeout() {},
        };
        fresh(req, r, (err) => reject(err || new Error('fell through')));
    });
    require.cache[dbPath].exports = real;
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { error: 'Failed to list tags' });
});
