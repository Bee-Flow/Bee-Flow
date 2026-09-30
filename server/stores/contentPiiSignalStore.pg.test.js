'use strict';

/**
 * content_pii_signals against a real Postgres (pglite), through the store's
 * own SQL: one row per subject, replaced in place, org-scoped reads, and
 * nothing stored that could be turned back into what was found.
 *
 * Run: cd server && node --test stores/contentPiiSignalStore.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { DDL, makeContentPiiSignalStore } = require('./contentPiiSignalStore');

const { pg, db } = pgliteDb();
const store = makeContentPiiSignalStore(db);

before(async () => { await pg.exec(DDL); await pg.exec(DDL); });
after(() => pg.close());

test('a scan result is one row per subject, replaced by the next scan', async () => {
    const first = await store.upsertSignal({
        organizationId: 'org1', projectId: 'p1', subjectKind: 'studio_document', subjectId: 'd1', versionId: 'v1',
        categories: { Person: 3, Email: 1, Bogus: 0, '': 4 }, kinds: ['name', 'email', 'name'], mentionCount: 4,
    });
    assert.deepStrictEqual(first.categories, { Person: 3, Email: 1 }, 'zero counts and empty keys are dropped');
    assert.deepStrictEqual(first.kinds.sort(), ['email', 'name']);
    assert.strictEqual(first.degraded, false);

    const second = await store.upsertSignal({
        organizationId: 'org1', projectId: 'p1', subjectKind: 'studio_document', subjectId: 'd1', versionId: 'v2',
        categories: {}, kinds: [], mentionCount: 0, degraded: true,
    });
    assert.strictEqual(second.versionId, 'v2');
    assert.strictEqual(second.degraded, true);
    const { rows } = await pg.query(`SELECT COUNT(*)::int AS n FROM content_pii_signals`);
    assert.strictEqual(rows[0].n, 1);
});

test('reads are scoped to the organisation', async () => {
    await store.upsertSignal({ organizationId: 'org2', projectId: 'p9', subjectKind: 'notebook_document', subjectId: 'n1', mentionCount: 2, kinds: ['health'], categories: { MedicalCondition: 2 } });
    assert.deepStrictEqual((await store.listForOrg('org1')).map(r => r.subjectId), ['d1']);
    assert.deepStrictEqual((await store.listForOrg('org2')).map(r => r.subjectId), ['n1']);
    assert.strictEqual((await store.getSignal('notebook_document', 'n1')).kinds[0], 'health');
});

test('the columns hold categories, kinds and counts only', async () => {
    const { rows } = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'content_pii_signals' ORDER BY column_name`);
    assert.deepStrictEqual(rows.map(r => r.column_name), [
        'categories', 'degraded', 'kinds', 'mention_count', 'organization_id', 'project_id', 'scanned_at', 'subject_id', 'subject_kind', 'version_id',
    ]);
});

test('an unknown subject kind is refused; deleting forgets the subject', async () => {
    await assert.rejects(store.upsertSignal({ organizationId: 'o', subjectKind: 'email', subjectId: 'x' }), /Unknown subject kind/);
    assert.strictEqual(await store.deleteSignal('notebook_document', 'n1'), true);
    assert.strictEqual(await store.getSignal('notebook_document', 'n1'), null);
    assert.strictEqual(await store.deleteSignal('notebook_document', 'n1'), false);
});
