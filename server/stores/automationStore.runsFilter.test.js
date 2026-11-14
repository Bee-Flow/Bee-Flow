// @typecheck strict
'use strict';

/**
 * The executions table's keyset cursor and its server-side filters. The
 * cursor helpers are pure; the filters run against a real Postgres (the boot
 * ladder's schema on PGlite, testUtils/pgliteTemplate.js ladderPglite, behind
 * db.js's pool) through the store's list functions, and the scope builder's
 * clause through the same joins the list uses.
 *
 * Run: cd server && node --test stores/automationStore.runsFilter.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./automationStore');
const { encodeRunCursor, decodeRunCursor, buildRunFilterWhere } = store;
const { JOURNEY_LATERAL, ORG_SCOPE_JOIN } = require('./automationStore/runsFilter');

before(async () => {
    // The store's init backfills automations.organization_id; the rows below come after it, so a
    // NULL there is what the list has to cope with.
    await store.initDB();
    await pg.exec(`
        INSERT INTO users (id, username, "organizationId") VALUES ('u1', 'u1', 'org-9'), ('u2', 'u2', 'org-9'), ('u3', 'u3', 'org-other');
        INSERT INTO automations (id, user_id, title, definition_json, organization_id, kind, deleted_at) VALUES
            ('a1', 'u1', 'Mine', '{}', 'org-9', 'automation', NULL),
            ('a-legacy', 'u2', 'Before the column', '{}', NULL, 'automation', NULL),
            ('a-orphan', 'gone', 'Owner deleted', '{}', 'org-9', 'block', NULL),
            ('a-trash', 'u1', 'Trashed', '{}', 'org-9', 'automation', NOW()),
            ('a-other', 'u3', 'Other org', '{}', 'org-other', 'automation', NULL);
        INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, mode, status, started_at, root_run_id) VALUES
            ('r1', 'a1', 1, 'u1', 'manual', 'live', 'error', '2026-06-26T10:00:00Z', NULL),
            ('r2', 'a1', 1, 'u1', 'form', 'live', 'success', '2026-06-26T11:00:00Z', 'r2'),
            ('r2-leg', 'a1', 1, 'u1', 'form', 'live', 'awaiting_form', '2026-06-26T11:05:00Z', 'r2'),
            ('r3', 'a1', 1, 'u1', 'manual', 'test', 'success', '2026-06-28T10:00:00Z', NULL),
            ('r-legacy', 'a-legacy', 1, 'u2', 'manual', 'live', 'success', '2026-06-26T12:00:00Z', NULL),
            ('r-orphan', 'a-orphan', 1, 'gone', 'schedule', 'live', 'success', '2026-06-26T13:00:00Z', NULL),
            ('r-trash', 'a-trash', 1, 'u1', 'manual', 'live', 'success', '2026-06-26T14:00:00Z', NULL),
            ('r-other', 'a-other', 1, 'u3', 'manual', 'live', 'success', '2026-06-26T15:00:00Z', NULL);
    `);
});
after(close);

/** @param {{ runs: Array<{ id: string }> }} out */
const ids = (out) => out.runs.map((r) => r.id).sort();

/**
 * The scope builder's clause through the list's own joins.
 * @param {any} scope
 */
async function idsFor(scope, filters = {}) {
    const w = buildRunFilterWhere(scope, filters, 1);
    const { rows } = await pg.query(
        `SELECT r.id FROM automation_runs r JOIN automations a ON a.id = r.automation_id${w.joinUsers ? ORG_SCOPE_JOIN : ''}${JOURNEY_LATERAL}
          WHERE ${w.clause} ORDER BY r.id`, w.params);
    return { rows: rows.map((x) => x.id), params: w.params };
}

test('run cursor round-trips (started_at, id)', () => {
    const row = { started_at: '2026-06-27T10:00:00.000Z', id: 'run-123' };
    const cur = encodeRunCursor(row);
    assert.equal(typeof cur, 'string');
    const back = decodeRunCursor(cur);
    assert.ok(back);
    assert.equal(back.startedAt, '2026-06-27T10:00:00.000Z');
    assert.equal(back.id, 'run-123');
});

test('encodeRunCursor returns null without a started_at (queued rows)', () => {
    assert.equal(encodeRunCursor({ id: 'x', started_at: null }), null);
    assert.equal(encodeRunCursor(null), null);
});

test('decodeRunCursor tolerates garbage → null (falls back to page 1)', () => {
    assert.equal(decodeRunCursor('not-base64!!'), null);
    assert.equal(decodeRunCursor(''), null);
    assert.equal(decodeRunCursor(undefined), null);
    assert.equal(decodeRunCursor(Buffer.from('{"nope":1}').toString('base64url')), null);
});

test("the user scope lists that user's runs, journey heads only, never the trash", async () => {
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', {})), ['r1', 'r2', 'r3']);
    assert.deepStrictEqual(ids(await store.listRunsForUser('u2', {})), ['r-legacy']);
    // The user scope reads automation_runs.user_id alone: a deleted owner row does not drop their own runs.
    assert.deepStrictEqual(ids(await store.listRunsForUser('gone', {})), ['r-orphan']);
});

test("the org scope: COALESCE over the automation AND its owner's org, and a missing owner row loses nothing", async () => {
    // `a.organization_id = $1` alone would drop every automation created before
    // that column was written; an INNER users join would drop one whose owner is gone.
    assert.deepStrictEqual(ids(await store.listRunsForOrg('org-9', {})), ['r-legacy', 'r-orphan', 'r1', 'r2', 'r3']);
    assert.deepStrictEqual(ids(await store.listRunsForOrg('org-other', {})), ['r-other']);
});

test('the scope builder fails CLOSED for every scope it cannot prove', async () => {
    // Each of these is one missing null-check upstream away from "every run in the database".
    const denied = [
        undefined, null, {}, { user: {} }, { org: {} },
        { user: { userId: null }, org: { orgId: null } },
        { org: { orgId: '' } }, { user: { userId: '' } },
        // Both at once is a caller bug, and "org wins" would be the widening reading.
        { user: { userId: 'u1' }, org: { orgId: 'org-9' } },
    ];
    for (const scope of denied) {
        const out = await idsFor(scope);
        assert.deepStrictEqual(out.rows, [], `scope ${JSON.stringify(scope)} must match nothing`);
        assert.deepStrictEqual(out.params, [], 'a refused scope binds no parameters');
    }
});

test('array and scalar filters narrow the list; status is the JOURNEY status', async () => {
    // A head reads 'success' the moment it hands off: filtering on its own status
    // would file a still-paused form under 'Success'.
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', { status: ['awaiting_form'] })), ['r2']);
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', { status: ['success'] })), ['r3']);
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', { triggerKind: 'manual' })), ['r1', 'r3']);
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', { mode: ['test'] })), ['r3']);
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', { sinceTs: '2026-06-26T00:00:00Z', untilTs: '2026-06-27T00:00:00Z' })), ['r1', 'r2']);
    assert.deepStrictEqual(ids(await store.listRunsForOrg('org-9', { kind: 'block' })), ['r-orphan']);
});

test('the org scope INTERSECTS its filters: automationId narrows, it never replaces', async () => {
    assert.deepStrictEqual(ids(await store.listRunsForOrg('org-9', { automationId: 'a1' })), ['r1', 'r2', 'r3']);
    assert.deepStrictEqual(ids(await store.listRunsForOrg('org-9', { automationId: 'a-other' })), [], "another organisation's automation stays out");
});

test('empty or blank filter values are ignored', async () => {
    assert.deepStrictEqual(ids(await store.listRunsForUser('u1', { status: [], triggerKind: '', automationId: null })), ['r1', 'r2', 'r3']);
});

test('runs of automations in the trash are left out, except in the one-automation scope', async () => {
    assert.ok(!ids(await store.listRunsForOrg('org-9', {})).includes('r-trash'));
    assert.deepStrictEqual(ids(await store.listRunsForAutomation('a-trash', {})), ['r-trash']);
});

test('only journey heads are listed, whatever else is filtered, in both scopes', async () => {
    for (const list of [(/** @type {any} */ f) => store.listRunsForUser('u1', f), (/** @type {any} */ f) => store.listRunsForOrg('org-9', f)]) {
        for (const filters of [{}, { status: ['awaiting_form'] }, { automationId: 'a1', triggerKind: 'form' }]) {
            assert.ok(!ids(await list(filters)).includes('r2-leg'), JSON.stringify(filters));
        }
    }
});
