// @typecheck
/**
 * The AI Act register against a real Postgres (@electric-sql/pglite): an
 * assessment whose target was removed stays in the table (it is part of the
 * record of what was checked), but leaves everything that counts — the
 * default register list, `stats` and `listExpiring` — while
 * `listForOrg({ includeRemoved: true })` still returns it. signals.targetsFor
 * names the same three states the register shows (live | trashed | gone), and
 * the two must agree on which targets are live.
 *
 * Run: cd server && node --test stores/aiActAssessmentStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./aiActAssessmentStore');
const signals = require('../compliance/aiAct/signals');

const DAY = 86400 * 1000;

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await pg.exec(`CREATE TABLE automations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, organization_id TEXT, title TEXT NOT NULL,
        deleted_at TIMESTAMPTZ)`);
    await pg.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, organization_id TEXT)`);
    await pg.exec(`INSERT INTO users (id, "organizationId") VALUES ('u1', 'org-1'), ('u2', 'org-2')`);
    await pg.exec(`INSERT INTO automations (id, user_id, organization_id, title, deleted_at) VALUES
        ('au-live', 'u1', 'org-1', 'Letters', NULL),
        ('au-legacy', 'u1', NULL, 'Legacy flow', NULL),
        ('au-trash', 'u1', 'org-1', 'Old letters', NOW()),
        ('au-other', 'u2', 'org-2', 'Elsewhere', NULL)`);
    await pg.exec(`INSERT INTO agents (id, name, organization_id) VALUES ('ag-live', 'Helpdesk', 'org-1'), ('ag-other', 'Other', 'org-2')`);
    await store.initDB();

    const soon = new Date(Date.now() + 5 * DAY);
    const lapsed = new Date(Date.now() - 5 * DAY);
    // au-other is another org's automation: an org-1 row naming it is not live for org-1.
    for (const id of ['au-live', 'au-legacy', 'au-trash', 'au-gone', 'au-other']) {
        await store.record('org-1', 'automation', id, { outcome: 'minimal', expiresAt: id === 'au-live' ? soon : lapsed });
    }
    await store.record('org-1', 'agent', 'ag-live', { outcome: 'transparency', expiresAt: lapsed });
    await store.record('org-1', 'agent', 'ag-gone', { outcome: 'transparency', expiresAt: lapsed });
});
after(close);

const ids = (rows) => rows.map(r => `${r.target_kind}:${r.target_id}`).sort();
const LIVE = ['agent:ag-live', 'automation:au-legacy', 'automation:au-live'];

test('the default register list, stats and listExpiring hold live targets only', async () => {
    assert.deepStrictEqual(ids(await store.listForOrg('org-1')), LIVE);
    assert.deepStrictEqual(await store.stats('org-1'), { attested: 1, expired: 2 });
    assert.deepStrictEqual(ids(await store.listExpiring('org-1', 30)), LIVE);
});

test('includeRemoved returns every assessed target; the rows themselves are kept', async () => {
    assert.deepStrictEqual(ids(await store.listForOrg('org-1', { includeRemoved: true })), [
        'agent:ag-gone', 'agent:ag-live',
        'automation:au-gone', 'automation:au-legacy', 'automation:au-live', 'automation:au-other', 'automation:au-trash',
    ]);
    assert.strictEqual((await store.listHistory('org-1', 'automation', 'au-trash')).length, 1);
});

test('signals.targetsFor names each target live, trashed or gone, and agrees with the store on live', async () => {
    const rows = await store.listForOrg('org-1', { includeRemoved: true });
    const t = await signals.targetsFor('org-1', rows);
    assert.deepStrictEqual(t.automation, {
        'au-live': { title: 'Letters', state: 'live' },
        'au-legacy': { title: 'Legacy flow', state: 'live' },
        'au-trash': { title: 'Old letters', state: 'trashed' },
        'au-gone': { title: null, state: 'gone' },
        'au-other': { title: null, state: 'gone' },
    });
    assert.deepStrictEqual(t.agent, {
        'ag-live': { title: 'Helpdesk', state: 'live' },
        'ag-gone': { title: null, state: 'gone' },
    });
    const live = rows.filter(r => t[r.target_kind][r.target_id].state === 'live');
    assert.deepStrictEqual(ids(live), LIVE);
});
