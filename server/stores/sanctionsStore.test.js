// @typecheck
'use strict';
/**
 * sanctions_lists / sanctions_entities / sanctions_names against a real Postgres (PGlite): a list
 * is swapped whole, a failure keeps the rows, candidates come back by shared key.
 * Run: cd server && node --test stores/sanctionsStore.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeSanctionsStore, SANCTIONS_DDL } = require('./sanctionsStore.mts');
const { nameKeys } = require('../core/sanctions/normalize.mts');
const { indexEntity } = require('../core/sanctions/entity.mts');

const { pg, db } = pgliteDb();
const store = makeSanctionsStore(db);

const entity = (id, names, over = {}) => indexEntity({
    entityId: id, kind: 'person', names, birthDates: ['1970-05-04'], countries: ['NL'], programmes: ['TST'],
    reference: `REF-${id}`, url: `https://example.test/${id}`, ...over,
});

before(async () => {
    for (const sql of SANCTIONS_DDL) await pg.exec(sql);
    await pg.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY, org_enabled_integrations TEXT)');
});
after(async () => { await pg.close(); });

test('replaceList swaps the rows of one list and leaves the other lists alone', async () => {
    await store.replaceList('eu_fsf', 'EU', [entity('1', ['Joran Testmann', 'J. Testman']), entity('1', ['duplicate id is dropped'])], { etag: '"a"' });
    await store.replaceList('un_sc', 'UN', [entity('9', ['Aldo Examplo'])], {});
    const counts = await store.replaceList('eu_fsf', 'EU', [entity('2', ['Petra Probeersma'])], { etag: '"b"', contentHash: 'h2' });
    assert.deepStrictEqual(counts, { entities: 1, names: 1 });
    const { rows } = await pg.query('SELECT list_id, entity_id FROM sanctions_entities ORDER BY list_id, entity_id');
    assert.deepStrictEqual(rows, [{ list_id: 'eu_fsf', entity_id: '2' }, { list_id: 'un_sc', entity_id: '9' }]);
    const status = await store.listStatus();
    const eu = status.find((s) => s.id === 'eu_fsf');
    assert.strictEqual(eu?.status, 'ok');
    assert.strictEqual(eu?.entityCount, 1);
    assert.strictEqual(eu?.etag, '"b"');
    assert.strictEqual(eu?.contentHash, 'h2');
    assert.ok(eu?.replacedAt);
});

test('a failure is recorded without touching the rows; unchanged keeps the counts', async () => {
    await store.recordFailure('eu_fsf', 'EU', 'the server answered HTTP 503');
    let eu = (await store.listStatus()).find((s) => s.id === 'eu_fsf');
    assert.strictEqual(eu?.status, 'error');
    assert.strictEqual(eu?.lastError, 'the server answered HTTP 503');
    assert.strictEqual(eu?.entityCount, 1);
    const { rows } = await pg.query("SELECT count(*)::int AS n FROM sanctions_names WHERE list_id = 'eu_fsf'");
    assert.strictEqual(rows[0].n, 1);
    await store.recordUnchanged('eu_fsf', 'EU', { etag: null });
    eu = (await store.listStatus()).find((s) => s.id === 'eu_fsf');
    assert.strictEqual(eu?.status, 'ok');
    assert.strictEqual(eu?.lastError, null);
    assert.strictEqual(eu?.etag, '"b"', 'an unchanged answer without an ETag keeps the stored one');
});

test('a failing insert rolls the whole swap back', async () => {
    await assert.rejects(store.replaceList('un_sc', 'UN', [entity('10', ['New Name'], { kind: null })], {}));
    const { rows } = await pg.query("SELECT entity_id FROM sanctions_entities WHERE list_id = 'un_sc'");
    assert.deepStrictEqual(rows, [{ entity_id: '9' }]);
});

test('candidates: names sharing a key, with their entity, optionally per list', async () => {
    const found = await store.candidates(nameKeys('Petra Probersma'), null, 100);
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0], {
        listId: 'eu_fsf', entityId: '2', name: 'Petra Probeersma', kind: 'person', primaryName: 'Petra Probeersma',
        birthDates: ['1970-05-04'], countries: ['NL'], programmes: ['TST'], reference: 'REF-2', url: 'https://example.test/2',
    });
    assert.deepStrictEqual(await store.candidates(nameKeys('Petra Probersma'), ['un_sc'], 100), []);
    assert.deepStrictEqual(await store.candidates([], null, 100), []);
});

test('anyOrganisationUses reads the org switch', async () => {
    assert.strictEqual(await store.anyOrganisationUses('sanctions-lists'), false);
    await pg.query(`INSERT INTO organizations (id, org_enabled_integrations) VALUES ('o1', '["maps","sanctions-lists"]')`);
    assert.strictEqual(await store.anyOrganisationUses('sanctions-lists'), true);
});

test('screening demand: one row, a time only', async () => {
    assert.strictEqual(await store.hasRecentDemand(48), false);
    await store.recordDemand();
    await store.recordDemand();
    assert.strictEqual(await store.hasRecentDemand(48), true);
    const { rows } = await pg.query('SELECT count(*)::int AS n FROM sanctions_demand');
    assert.strictEqual(rows[0].n, 1);
});
