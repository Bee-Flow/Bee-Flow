/**
 * The project change feed (projects/changeFeed.js).
 *
 * The recorders run against the REAL project store over pglite
 * (makeProjectStore + applyProjectSchema), with the doorbell injected, so the
 * folding is proven on the production SQL. The reader's grouping and window
 * are pure and tested directly.
 *
 * Pinned:
 *   - a checkpoint becomes one session row per person; the AI acting for a
 *     person folds into their row ("with AI"); AI work for nobody has its own
 *     row; stats are shared so the rows add up to the whole;
 *   - saves inside a session fold; events carry ids and counts only;
 *   - quiet sources record nothing; a restore and a named version are
 *     one-off entries; bad input and a failing store never throw;
 *   - created / renamed / moved entries and the transactional logAndEmit;
 *   - grouping by item and by person, unread against the reader's
 *     watermark, minor edits, the "since your last visit" window.
 *
 * Run: cd server && node --test projects/changeFeed.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { makeProjectStore, applyProjectSchema } = require('../stores/projectStore');
const { makeChangeFeed, summarizeChanges, changeWindow } = require('./changeFeed');

function facadeFor(pg) {
    const query = async (sql, params) => {
        const r = params && params.length ? await pg.query(sql, params) : await pg.query(sql);
        const rows = r.rows || [];
        return { rows, rowCount: typeof r.affectedRows === 'number' ? r.affectedRows : rows.length };
    };
    return {
        run: query,
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        getClient: async () => ({ query, release() {} }),
    };
}

let pg;
let store;
const published = [];
const warnings = [];
const quietLog = { warn: (...a) => warnings.push(a.join(' ')), info() {}, error() {}, debug() {} };
let feed;

before(async () => {
    pg = new PGlite();
    await applyProjectSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: async (_t, statements) => { for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql); },
    });
    store = makeProjectStore(facadeFor(pg));
    feed = makeChangeFeed({ store, publish: async (projectId, ev) => { published.push([projectId, ev]); }, log: quietLog });
});
after(async () => { await pg.close(); });
beforeEach(() => { published.length = 0; warnings.length = 0; });

const rowsOf = async (pid) => (await pg.query('SELECT * FROM project_activity WHERE project_id = $1 ORDER BY actor_id NULLS LAST', [pid])).rows;
const newProject = async () => (await store.createProject({ name: 'P', ownerId: 'owner' })).id;

// Event payloads may only carry these keys: ids, counts and flags.
const ALLOWED_PAYLOAD_KEYS = new Set([
    'itemType', 'itemId', 'targetType', 'targetId', 'activityId', 'versionId', 'changes', 'wordsAdded', 'wordsRemoved',
    'blocksChanged', 'aiAssisted', 'minor', 'stats', 'agentIds',
]);
function assertCountsOnly(ev) {
    for (const key of Object.keys(ev.payload || {})) assert.ok(ALLOWED_PAYLOAD_KEYS.has(key), `payload key ${key}`);
}

test('a checkpoint becomes one row per person, the AI folded into whom it worked for', async () => {
    const pid = await newProject();
    const out = await feed.recordContentChange({
        projectId: pid, itemType: 'document', itemId: 'd1', versionId: 'v1', source: 'checkpoint',
        contributors: [{ userId: 'anna', kind: 'user' }, { userId: 'anna', kind: 'ai', agentId: 'ag1' }, { userId: 'bob', kind: 'user' }],
        stats: { wordsAdded: 11, wordsRemoved: 3, blocksChanged: 2 },
    });
    assert.deepStrictEqual(out, { recorded: 2 });
    const rows = await rowsOf(pid);
    assert.deepStrictEqual(rows.map((r) => [r.actor_id, r.actor_kind, r.action, r.version_id]), [
        ['anna', 'user', 'content.edited', 'v1'],
        ['bob', 'user', 'content.edited', 'v1'],
    ]);
    assert.strictEqual(rows[0].details.aiAssisted, true);
    assert.deepStrictEqual(rows[0].details.agentIds, ['ag1']);
    assert.strictEqual(rows[1].details.aiAssisted, false);
    const sum = (k) => rows.reduce((n, r) => n + r.details.stats[k], 0);
    assert.deepStrictEqual([sum('wordsAdded'), sum('wordsRemoved'), sum('blocksChanged')], [11, 3, 2]);
    assert.strictEqual(published.length, 2);
    for (const [projectId, ev] of published) {
        assert.strictEqual(projectId, pid);
        assert.strictEqual(ev.kind, 'content.edited');
        assert.strictEqual(ev.targetType, 'document');
        assertCountsOnly(ev);
    }
});

test('saves inside a session fold, and only a stale session re-announces itself', async () => {
    const pid = await newProject();
    const change = { projectId: pid, itemType: 'notebook', itemId: 'n1', source: 'autosave', contributors: [{ userId: 'anna' }], stats: { wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 } };
    await feed.recordContentChange({ ...change, versionId: 'v1' });
    await feed.recordContentChange({ ...change, versionId: 'v2' });
    await feed.recordContentChange({ ...change, versionId: 'v3', stats: { wordsAdded: 9, wordsRemoved: 0, blocksChanged: 1 } });
    const rows = await rowsOf(pid);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].details.changes, 3);
    assert.deepStrictEqual(rows[0].details.stats, { wordsAdded: 11, wordsRemoved: 0, blocksChanged: 3 });
    assert.strictEqual(rows[0].details.minor, false);
    assert.strictEqual(rows[0].version_id, 'v3');
    assert.strictEqual(published.length, 1, 'one event for the session so far');
});

test('an edit without counts is never folded away as a small one', async () => {
    const pid = await newProject();
    await feed.recordContentChange({ projectId: pid, itemType: 'notebook', itemId: 'n1', source: 'checkpoint', contributors: [{ userId: 'anna' }], stats: { sourcesAdded: 2 } });
    await feed.recordContentChange({ projectId: pid, itemType: 'notebook', itemId: 'n2', source: 'checkpoint', contributors: [{ userId: 'anna' }], stats: { wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 } });
    const rows = (await pg.query('SELECT item_id, details FROM project_activity WHERE project_id = $1 ORDER BY item_id', [pid])).rows;
    assert.deepStrictEqual(rows.map((r) => [r.item_id, r.details.minor, !!r.details.unknownCounts]), [['n1', false, true], ['n2', true, false]]);
});

test('AI work for nobody in particular has its own row; nobody at all is the system', async () => {
    const pid = await newProject();
    await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd1', source: 'ai', contributors: [{ kind: 'ai', agentId: 'ag' }] });
    await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd2', source: 'checkpoint', contributors: [] });
    const rows = await rowsOf(pid);
    assert.deepStrictEqual(rows.map((r) => [r.actor_id, r.actor_kind, r.item_id]).sort(), [[null, 'ai', 'd1'], [null, 'system', 'd2']]);
});

test('quiet sources record nothing; restores and named versions are one-off entries', async () => {
    const pid = await newProject();
    for (const source of ['created', 'pre_restore', 'conflict', 'import', 'legacy', 'mystery']) {
        assert.deepStrictEqual(await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd1', source, contributors: [{ userId: 'a' }] }), { recorded: 0 });
    }
    assert.deepStrictEqual(await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd1', source: 'named', contributors: [{ userId: 'a' }] }), { recorded: 0 });
    assert.strictEqual((await rowsOf(pid)).length, 0);

    await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd1', source: 'named', versionId: 'v5', contributors: [{ userId: 'a' }] });
    await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd1', source: 'restore', versionId: 'v6', contributors: [{ userId: 'a' }], stats: { wordsAdded: 2, wordsRemoved: 40, blocksChanged: 3 } });
    await feed.recordContentChange({ projectId: pid, itemType: 'document', itemId: 'd1', source: 'restore', versionId: 'v7', contributors: [{ userId: 'a' }] });
    const rows = (await pg.query('SELECT action, version_id, details FROM project_activity WHERE project_id = $1 ORDER BY created_at, version_id', [pid])).rows;
    assert.deepStrictEqual(rows.map((r) => [r.action, r.version_id]), [
        ['content.version_named', 'v5'], ['content.restored', 'v6'], ['content.restored', 'v7'],
    ]);
    assert.deepStrictEqual(rows[1].details.stats, { wordsAdded: 2, wordsRemoved: 40, blocksChanged: 3 });
    for (const [, ev] of published) assertCountsOnly(ev);
});

test('bad input and a failing store never throw', async () => {
    assert.deepStrictEqual(await feed.recordContentChange(null), { recorded: 0 });
    assert.deepStrictEqual(await feed.recordContentChange({ projectId: null, itemType: 'document', itemId: 'd' }), { recorded: 0 });
    assert.deepStrictEqual(await feed.recordContentChange({ projectId: 'p', itemType: 'automation', itemId: 'a' }), { recorded: 0 });
    const broken = makeChangeFeed({
        store: { recordContentSession: async () => { throw new Error('db down'); }, recordActivityEvent: async () => { throw new Error('db down'); } },
        publish: async () => { throw new Error('never'); },
        log: quietLog,
    });
    assert.deepStrictEqual(await broken.recordContentChange({ projectId: 'p', itemType: 'document', itemId: 'd', source: 'checkpoint', contributors: [{ userId: 'u' }] }), { recorded: 0 });
    assert.deepStrictEqual(await broken.recordItemCreated({ projectId: 'p', itemType: 'document', itemId: 'd', actorId: 'u' }), { recorded: 0 });
    assert.strictEqual(await broken.recordProjectChange('p', 'u', 'kb_added', {}), null);
    assert.strictEqual(warnings.length, 3);
});

test('created, renamed and moved are one-off entries; logAndEmit is one transaction', async () => {
    const pid = await newProject();
    await feed.recordItemCreated({ projectId: pid, itemType: 'document', itemId: 'd1', actorId: 'anna' });
    await feed.recordItemRenamed({ projectId: pid, itemType: 'document', itemId: 'd1', actorId: 'anna' });
    await feed.recordItemMoved({ projectId: pid, itemType: 'notebook', itemId: 'n1', actorId: 'bob', direction: 'in' });
    await feed.recordItemMoved({ projectId: pid, itemType: 'notebook', itemId: 'n1', actorId: 'bob', direction: 'out' });
    assert.deepStrictEqual(await feed.recordItemCreated({ projectId: pid, itemType: 'chat', itemId: 'c', actorId: 'x' }), { recorded: 0 });
    const out = await feed.recordProjectChange(pid, 'owner', 'kb_added', { targetType: 'kb', targetId: 'kb1' });
    assert.strictEqual(out.event.kind, 'kb_added');
    const rows = (await pg.query('SELECT action, seq FROM project_activity WHERE project_id = $1 ORDER BY seq', [pid])).rows;
    assert.deepStrictEqual(rows.map((r) => [r.action, Number(r.seq)]), [
        ['content.created', 1], ['content.renamed', 2], ['content.moved_in', 3], ['content.moved_out', 4], ['kb_added', 5],
    ]);
    assert.strictEqual(published.length, 5);
    for (const [, ev] of published) assertCountsOnly(ev);
});

// ── Reading (pure) ─────────────────────────────────────────────────────

const T = (min) => new Date(Date.parse('2026-09-29T12:00:00Z') + min * 60_000).toISOString();
const row = (over) => ({
    action: 'content.edited', actorKind: 'user', actorId: 'anna', itemType: 'document', itemId: 'd1',
    targetType: 'document', targetId: 'd1', versionId: null, details: { changes: 1, stats: { wordsAdded: 10, wordsRemoved: 0, blocksChanged: 1 }, minor: false },
    createdAt: T(0), updatedAt: T(0), ...over,
});

test('groups by item: counts, contributors, stats, latest version, kinds', () => {
    const rows = [
        row({ updatedAt: T(30), versionId: 'v9', actorId: 'bob', details: { changes: 2, stats: { wordsAdded: 3, wordsRemoved: 1, blocksChanged: 1 }, aiAssisted: true } }),
        row({ updatedAt: T(20), versionId: 'v8' }),
        row({ action: 'resource_added', itemType: null, itemId: null, targetType: 'notebook', targetId: 'n1', details: {}, updatedAt: T(10) }),
        row({ action: 'resource_added', itemType: null, itemId: null, targetType: 'automation', targetId: 'a1', details: {}, updatedAt: T(11) }),
        row({ action: 'member_added', targetType: 'user', targetId: 'x', itemType: null, itemId: null, updatedAt: T(12) }),
    ];
    const groups = summarizeChanges(rows, { state: { firstVisitAt: T(-100) } });
    assert.deepStrictEqual(groups.map((g) => `${g.item.type}:${g.item.id}`), ['document:d1', 'notebook:n1']);
    const [doc, nb] = groups;
    assert.strictEqual(doc.changeCount, 3);
    assert.deepStrictEqual(doc.contributors, [{ userId: 'bob', kind: 'user' }, { userId: 'bob', kind: 'ai' }, { userId: 'anna', kind: 'user' }]);
    assert.deepStrictEqual(doc.stats, { wordsAdded: 13, wordsRemoved: 1, blocksChanged: 2 });
    assert.strictEqual(doc.latestVersionId, 'v9');
    assert.deepStrictEqual(doc.kinds, ['edited']);
    assert.strictEqual(doc.aiAssisted, true);
    assert.strictEqual(doc.minor, false);
    assert.strictEqual(doc.lastChangedAt, T(30));
    assert.deepStrictEqual(nb.kinds, ['added']);
    assert.strictEqual('rows' in doc, false);
});

test('unread against the reader’s watermark; minor edits flagged; no state means nothing unread', () => {
    const rows = [
        row({ itemId: 'd1', targetId: 'd1', updatedAt: T(30) }),
        row({ itemId: 'd2', targetId: 'd2', updatedAt: T(5), details: { changes: 1, stats: { wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 }, minor: true } }),
        row({ itemId: 'd3', targetId: 'd3', updatedAt: T(40) }),
    ];
    const reads = new Map([['document:d3', { seenAt: T(45), seenVersionId: 'v-seen' }]]);
    const groups = summarizeChanges(rows, { state: { seenAt: T(10), firstVisitAt: T(-500) }, reads });
    const byId = Object.fromEntries(groups.map((g) => [g.item.id, g]));
    assert.strictEqual(byId.d1.unread, true);
    assert.strictEqual(byId.d2.unread, false, 'older than "seen everything"');
    assert.strictEqual(byId.d2.minor, true);
    assert.strictEqual(byId.d3.unread, false, 'seen after the change');
    assert.strictEqual(byId.d3.seenVersionId, 'v-seen');
    assert.strictEqual(byId.d3.seenAt, T(45), 'and when, so a pruned version has a moment to stand in for it');
    assert.strictEqual(byId.d1.seenAt, null);
    assert.deepStrictEqual(summarizeChanges(rows, { state: { seenAt: T(10) }, reads, onlyUnread: true }).map((g) => g.item.id), ['d1']);
    assert.ok(summarizeChanges(rows, { state: null }).every((g) => g.unread === false));
});

test('groups by person, with the AI for nobody as its own contributor', () => {
    const rows = [
        row({ actorId: 'anna', itemId: 'd1', targetId: 'd1', updatedAt: T(3) }),
        row({ actorId: 'anna', itemId: 'd2', targetId: 'd2', updatedAt: T(2), details: { changes: 4, aiAssisted: true } }),
        row({ actorId: null, actorKind: 'ai', itemId: 'd1', targetId: 'd1', updatedAt: T(1), details: { changes: 1 } }),
    ];
    const people = summarizeChanges(rows, { state: null, groupBy: 'person' });
    assert.deepStrictEqual(people.map((p) => [p.person, p.changeCount, p.items.map((i) => i.id)]), [
        [{ userId: 'anna', kind: 'user' }, 5, ['d1', 'd2']],
        [{ userId: null, kind: 'ai' }, 1, ['d1']],
    ]);
    assert.strictEqual(people[0].aiAssisted, true);
});

test('the window: since the last visit, since unread, since a time', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    assert.strictEqual(changeWindow('visit', null, now), null);
    assert.strictEqual(changeWindow('visit', { prevVisitAt: null, firstVisitAt: T(-5) }, now), null, 'first visit: nothing yet');
    assert.strictEqual(changeWindow('visit', { prevVisitAt: T(-60) }, now).toISOString(), T(-60));
    assert.strictEqual(changeWindow('visit', { prevVisitAt: T(-60), seenAt: T(-10) }, now).toISOString(), T(-10));
    assert.strictEqual(changeWindow('unread', null, now), null);
    assert.strictEqual(changeWindow('unread', { firstVisitAt: T(-20) }, now).toISOString(), T(-20));
    assert.strictEqual(changeWindow('unread', { firstVisitAt: '2020-01-01T00:00:00Z' }, now).toISOString(), new Date(now - 30 * 86400000).toISOString());
    assert.strictEqual(changeWindow(T(-30), null, now).toISOString(), T(-30));
    assert.strictEqual(changeWindow('2001-01-01T00:00:00Z', null, now).toISOString(), new Date(now - 90 * 86400000).toISOString());
    assert.strictEqual(changeWindow('yesterday', null, now), null);
});
