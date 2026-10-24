// @typecheck
'use strict';

/**
 * The upload lookup behind read_table, run for real against PGlite: only a
 * CLAIMED upload of a form page of THIS automation resolves.
 *
 * Run: cd server && node --test stores/automationStore/tableSources.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { pgliteQuery } = require('../../testUtils/pglitePool');
const { getClaimedFormUploadForAutomation } = require('./tableSources');

const pg = new PGlite();
const query = pgliteQuery(pg);
const db = {
    initDB: async () => {},
    getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
};

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_form_pages (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL);
        CREATE TABLE automation_form_uploads (
            id TEXT PRIMARY KEY, form_page_id TEXT NOT NULL, storage_key TEXT NOT NULL, filename TEXT NOT NULL,
            mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL DEFAULT 0, claimed_at TIMESTAMPTZ
        );
        INSERT INTO automation_form_pages VALUES ('p1', 'a1'), ('p2', 'a2');
        INSERT INTO automation_form_uploads VALUES
            ('u-claimed', 'p1', 'k/u1', 'data.xlsx', 'application/vnd.ms-excel', 2048, NOW()),
            ('u-open', 'p1', 'k/u2', 'draft.csv', 'text/csv', 10, NULL),
            ('u-other', 'p2', 'k/u3', 'other.csv', 'text/csv', 10, NOW());
    `);
});
after(async () => { await pg.close(); });

test('a claimed upload of this automation resolves, with only the allow-listed fields', async () => {
    assert.deepStrictEqual(await getClaimedFormUploadForAutomation('u-claimed', 'a1', db), {
        id: 'u-claimed', storageKey: 'k/u1', filename: 'data.xlsx', mimeType: 'application/vnd.ms-excel', size: 2048,
    });
});

test('an unclaimed upload does not resolve', async () => {
    assert.strictEqual(await getClaimedFormUploadForAutomation('u-open', 'a1', db), null);
});

test('an upload of another automation does not resolve', async () => {
    assert.strictEqual(await getClaimedFormUploadForAutomation('u-other', 'a1', db), null);
    assert.strictEqual(await getClaimedFormUploadForAutomation('u-claimed', 'a2', db), null);
});

test('missing ids resolve to nothing', async () => {
    assert.strictEqual(await getClaimedFormUploadForAutomation('nope', 'a1', db), null);
    assert.strictEqual(await getClaimedFormUploadForAutomation('', 'a1', db), null);
    assert.strictEqual(await getClaimedFormUploadForAutomation('u-claimed', '', db), null);
});
