'use strict';

/**
 * The change-feed routes (routes/projects/changes.js), end to end below the
 * role gate: the factory router is served behind a real express app and the
 * real terminal error handler, over the REAL project store, change feed and
 * title lookup on pglite. Only the role gate is a fake, answering like
 * auth/projectAccess.requireProjectRole: 401 without a session, 404 for a
 * non-member, 403 for a role that is too low.
 *
 * Proven: the refusals on every route; a first visit shows nothing; after a
 * pause the reader sees what others changed, never their own, with titles
 * resolved at read time; unread follows item and "everything" seen marks;
 * `since=unread`, `group=person`, the change log with paging; an item that
 * left the project loses its title; marking an item outside the project is
 * refused.
 *
 * Run: cd server && node --test routes/projects/changes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { assertRefused } = require('../../core/http/routeHarness');
const { makeProjectStore, applyProjectSchema } = require('../../stores/projectStore');
const { makeChangeFeed } = require('../../projects/changeFeed');
const { makeChangeTitles } = require('../../projects/changeTitles');
const { makeChangesRouter } = require('./changes');

const OWNER = { id: 'u_owner' };
const ANNA = { id: 'u_anna' };
const VERA = { id: 'u_vera' };
const STRANGER = { id: 'u_stranger' };
const ORDER = { viewer: 0, editor: 1, owner: 2 };

let pg;
let store;
let feed;
let projectId;
const roles = {};

function facadeFor(db) {
    const query = async (sql, params) => {
        const r = params && params.length ? await db.query(sql, params) : await db.query(sql);
        const rows = r.rows || [];
        return { rows, rowCount: typeof r.affectedRows === 'number' ? r.affectedRows : rows.length };
    };
    return {
        query,
        run: query,
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        getClient: async () => ({ query, release() {} }),
    };
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    req.session = who && who !== 'none' ? { user: JSON.parse(who) } : {};
    next();
});
const server = http.createServer(app);
const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

test.before(async () => {
    pg = new PGlite();
    await applyProjectSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: async (_t, statements) => { for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql); },
    });
    // The item tables as far as the title lookup reads them; no meetings
    // table, as on an install without meeting notes.
    await pg.exec(`
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE TABLE studio_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT,
            kind TEXT NOT NULL DEFAULT 'document', archived BOOLEAN NOT NULL DEFAULT false);
    `);
    const db = facadeFor(pg);
    store = makeProjectStore(db);
    feed = makeChangeFeed({ store, publish: async () => {}, log: { warn() {}, info() {} } });
    projectId = (await store.createProject({ name: 'Launch', ownerId: OWNER.id })).id;
    roles[projectId] = { u_owner: 'owner', u_anna: 'editor', u_vera: 'viewer' };
    await pg.query(`INSERT INTO studio_documents (id, name, project_id) VALUES ('d1', 'Launch brief', $1), ('d2', 'Budget', $1), ('d-out', 'Private plan', NULL)`, [projectId]);
    await pg.query(`INSERT INTO notebooks (id, name, project_id) VALUES ('n1', 'Interview notes', $1)`, [projectId]);

    const router = makeChangesRouter({
        requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Not authenticated' });
            const role = roles[req.params.id]?.[userId];
            if (!role) return res.status(404).json({ error: 'Not found' });
            if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
            return next();
        },
        store,
        titles: makeChangeTitles(db, { log: { warn() {} } }),
        markLimiter: function rateLimitMiddleware(_req, _res, next) { next(); },
    });
    app.use('/api/projects', router);
    app.use(terminalErrorHandler);
    await listening;
});

test.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await pg.close();
});

async function call(method, url, { user = VERA, body } = {}) {
    const headers = { 'x-test-user': user === null ? 'none' : JSON.stringify(user) };
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
}

const P = () => `/api/projects/${projectId}`;
const edit = (userId, itemType, itemId, extra = {}) => feed.recordContentChange({
    projectId, itemType, itemId, source: 'checkpoint', versionId: `v-${itemId}-${Date.now()}`,
    contributors: [{ userId, kind: 'user' }], stats: { wordsAdded: 12, wordsRemoved: 2, blocksChanged: 1 }, ...extra,
});
/** A pause: Vera's last visit (and everything recorded so far) moves back an hour. */
async function pause() {
    await pg.query(`UPDATE project_member_state SET last_visit_at = last_visit_at - INTERVAL '60 minutes',
                    visit_started_at = visit_started_at - INTERVAL '60 minutes',
                    first_visit_at = first_visit_at - INTERVAL '60 minutes' WHERE project_id = $1`, [projectId]);
    await pg.query(`UPDATE project_activity SET created_at = created_at - INTERVAL '61 minutes',
                    updated_at = updated_at - INTERVAL '61 minutes', emitted_at = emitted_at - INTERVAL '61 minutes'
                    WHERE project_id = $1`, [projectId]);
}

test('refusals: no session 401, not a member 404, bad input 400', async () => {
    for (const [method, path] of [['GET', '/changes'], ['GET', '/changes/log'], ['POST', '/visit'], ['POST', '/seen'], ['POST', '/items/document/d1/seen']]) {
        assert.strictEqual((await call(method, `${P()}${path}`, { user: null, body: method === 'POST' ? {} : undefined })).status, 401, path);
        assert.strictEqual((await call(method, `${P()}${path}`, { user: STRANGER, body: method === 'POST' ? {} : undefined })).status, 404, path);
        assert.strictEqual((await call(method, `/api/projects/nope${path}`, { user: OWNER, body: method === 'POST' ? {} : undefined })).status, 404, path);
    }
    assertRefused(assert, await call('GET', `${P()}/changes?since=lastweek`), 'query.since', /since is "visit"/);
    assertRefused(assert, await call('GET', `${P()}/changes?group=team`), 'query.group', /group is "item" or "person"/);
    assertRefused(assert, await call('GET', `${P()}/changes?limit=5`), null, /does not take "limit"/);
    assertRefused(assert, await call('GET', `${P()}/changes/log?limit=500`), 'query.limit', /from 1 to 100/);
    assertRefused(assert, await call('POST', `${P()}/visit`, { body: { at: 'now' } }), null, /does not take "at"/);
    assertRefused(assert, await call('POST', `${P()}/items/automation/a1/seen`, { body: {} }), 'params.type', /notebook, document or meeting/);
    assertRefused(assert, await call('POST', `${P()}/items/document/d1/seen`, { body: { versionId: 5 } }), 'body.versionId', /versionId/);
    assert.strictEqual(await store.getMemberState(projectId, STRANGER.id), null);
});

test('a first visit shows nothing yet; after a pause, what others changed — never my own', async () => {
    const first = await call('POST', `${P()}/visit`, { body: {} });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.prevVisitAt, null);
    const empty = await call('GET', `${P()}/changes?since=visit`);
    assert.deepStrictEqual(empty.body.groups, []);
    assert.strictEqual(empty.body.prevVisitAt, null);

    await pause();
    await edit(ANNA.id, 'document', 'd1');
    await edit(ANNA.id, 'document', 'd1', { contributors: [{ userId: ANNA.id }, { userId: ANNA.id, kind: 'ai', agentId: 'ag' }] });
    await edit(VERA.id, 'document', 'd2');
    await edit(ANNA.id, 'notebook', 'n1');
    const visit = await call('POST', `${P()}/visit`, { body: {} });
    assert.ok(visit.body.prevVisitAt, 'a previous visit is known now');

    const res = await call('GET', `${P()}/changes`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.since, 'visit');
    assert.strictEqual(res.body.truncated, false, 'nothing was cut');
    const byId = Object.fromEntries(res.body.groups.map((g) => [g.item.id, g]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['d1', 'n1'], 'Vera’s own edit of d2 is not news to her');
    assert.deepStrictEqual(byId.d1.item, { type: 'document', id: 'd1', title: 'Launch brief', available: true });
    assert.strictEqual(byId.d1.changeCount, 2);
    assert.strictEqual(byId.d1.aiAssisted, true);
    assert.deepStrictEqual(byId.d1.contributors, [{ userId: ANNA.id, kind: 'user' }, { userId: ANNA.id, kind: 'ai' }]);
    assert.deepStrictEqual(byId.d1.stats, { wordsAdded: 24, wordsRemoved: 4, blocksChanged: 2 });
    assert.strictEqual(byId.d1.unread, true);
    assert.match(byId.d1.latestVersionId, /^v-d1-/);
    assert.strictEqual(byId.n1.item.title, 'Interview notes');

    // Anna does not see her own changes either.
    const annaView = await call('GET', `${P()}/changes?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`, { user: ANNA });
    assert.deepStrictEqual(annaView.body.groups.map((g) => g.item.id), ['d2']);
});

test('item and "everything" seen marks clear unread; unread lists only unread items', async () => {
    const unreadBefore = await call('GET', `${P()}/changes?since=unread`);
    assert.deepStrictEqual(unreadBefore.body.groups.map((g) => g.item.id).sort(), ['d1', 'n1']);

    const mark = await call('POST', `${P()}/items/document/d1/seen`, { body: { versionId: 'v-shown' } });
    assert.strictEqual(mark.status, 200);
    assert.strictEqual(mark.body.seenVersionId, 'v-shown');
    const after = await call('GET', `${P()}/changes`);
    const d1 = after.body.groups.find((g) => g.item.id === 'd1');
    assert.strictEqual(d1.unread, false);
    assert.strictEqual(d1.seenVersionId, 'v-shown');
    assert.deepStrictEqual((await call('GET', `${P()}/changes?since=unread`)).body.groups.map((g) => g.item.id), ['n1']);

    assert.strictEqual((await call('POST', `${P()}/items/document/d-out/seen`, { body: {} })).status, 404);
    assert.strictEqual((await call('POST', `${P()}/items/meeting/m1/seen`, { body: {} })).status, 404);

    const all = await call('POST', `${P()}/seen`, { body: {} });
    assert.strictEqual(all.status, 200);
    assert.ok(all.body.seenAt);
    assert.deepStrictEqual((await call('GET', `${P()}/changes?since=unread`)).body.groups, []);
    assert.deepStrictEqual((await call('GET', `${P()}/changes?since=visit`)).body.groups, [], 'everything seen clears the section');
});

test('groups by person, and the change log pages with titles', async () => {
    const since = encodeURIComponent(new Date(Date.now() - 3 * 3600_000).toISOString());
    const people = await call('GET', `${P()}/changes?since=${since}&group=person`, { user: OWNER });
    assert.deepStrictEqual(people.body.groups.map((p) => [p.person.userId, p.items.map((i) => i.title).sort()]), [
        [ANNA.id, ['Interview notes', 'Launch brief']],
        [VERA.id, ['Budget']],
    ]);

    const page1 = await call('GET', `${P()}/changes/log?limit=2`, { user: VERA });
    assert.strictEqual(page1.status, 200);
    assert.strictEqual(page1.body.items.length, 2);
    assert.strictEqual(page1.body.hasMore, true);
    const page2 = await call('GET', `${P()}/changes/log?limit=2&offset=2`, { user: VERA });
    const all = [...page1.body.items, ...page2.body.items];
    assert.deepStrictEqual(all.map((i) => i.title).sort(), ['Budget', 'Interview notes', 'Launch brief']);
    for (const item of all) {
        assert.strictEqual(item.action, 'content.edited');
        assert.ok(!('name' in item.details) && !('title' in item.details), 'no titles stored');
    }
});

test('an item that left the project loses its title and shows only as leaving', async () => {
    await pg.query(`UPDATE studio_documents SET project_id = NULL WHERE id = 'd2'`);
    await feed.recordItemMoved({ projectId, itemType: 'document', itemId: 'd2', actorId: ANNA.id, direction: 'out' });
    await edit(ANNA.id, 'document', 'd-out');
    const res = await call('GET', `${P()}/changes?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
    const ids = res.body.groups.map((g) => g.item.id);
    assert.ok(ids.includes('d2'));
    assert.ok(!ids.includes('d-out'), 'an edit of an item outside the project is not shown');
    const gone = res.body.groups.find((g) => g.item.id === 'd2');
    assert.deepStrictEqual(gone.item, { type: 'document', id: 'd2', title: null, available: false });
    assert.deepStrictEqual(gone.kinds, ['removed']);
    const log = await call('GET', `${P()}/changes/log?limit=1`);
    assert.strictEqual(log.body.items[0].title, null);
});
