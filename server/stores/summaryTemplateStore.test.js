'use strict';

/**
 * Store tests — template version, on a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js) with the store's own boot DDL.
 *
 * What is held here:
 *   1. `version` is in the boot DDL of this store: a table from before it gets
 *      the column from the idempotent ALTER, existing rows start at 1.
 *   2. Raising happens on a REAL prompt change, and only there: renaming and
 *      setting as default leave the version as it is.
 *   3. mapRow distinguishes "no version known" (null) from 1.
 *   4. resolveDefaultTemplate returns the ROW — a prompt alone is not enough to
 *      stamp a note with.
 *
 * Run: cd server && node --test stores/summaryTemplateStore.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
// An install from before `version`: the table exists without the column.
const ready = pg.exec(`CREATE TABLE summary_templates (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
    user_id TEXT, organization_id TEXT, group_id TEXT, is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO summary_templates (id, scope, name, prompt, user_id) VALUES ('legacy', 'user', 'Oud', 'P', 'u-old');`);
const store = require('./summaryTemplateStore');
test.after(close);

test.before(async () => { await ready; await store.initDB(); });
test.beforeEach(async () => { await pg.exec("DELETE FROM summary_templates WHERE id <> 'legacy'"); });

/** @param {Record<string, unknown>} over */
const tpl = (over) => insertRow(pg, 'summary_templates', { id: 't-1', scope: 'user', user_id: 'u-1', name: 'Mijn', prompt: 'P', ...over });
const versionOf = async (id = 't-1') => (await pg.query('SELECT version FROM summary_templates WHERE id = $1', [id])).rows[0].version;

test('version zit in de boot-DDL — een bestaande tabel krijgt hem uit de idempotente ALTER', async () => {
    assert.strictEqual((await store.getById('legacy')).version, 1, 'bestaande rijen beginnen op 1');
    const { rows } = await pg.query(`SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'summary_templates' AND column_name = 'version'`);
    assert.deepStrictEqual(rows, [{ is_nullable: 'NO', column_default: '1' }]);
});

test('elke lezer krijgt version mee', async () => {
    await tpl({ version: 4 });
    assert.strictEqual((await store.getById('t-1')).version, 4);
    assert.deepStrictEqual((await store.listVisible({ userId: 'u-1' })).map(t => t.version), [4]);
    assert.deepStrictEqual((await store.listForUser('u-1')).map(t => t.version), [4]);
});

test('mapRow onderscheidt "geen versie" van versie 1', async () => {
    // A row from a replica that has not run the ladder yet. Filling in `1` would
    // claim a version that comes from nowhere.
    await tpl({ version: 0 });
    assert.strictEqual((await store.getById('t-1')).version, null, 'version=0 → null');
    await pg.exec('ALTER TABLE summary_templates ALTER COLUMN version DROP NOT NULL');
    try {
        await pg.query("UPDATE summary_templates SET version = NULL WHERE id = 't-1'");
        assert.strictEqual((await store.getById('t-1')).version, null, 'version=NULL → null');
    } finally {
        await pg.exec("UPDATE summary_templates SET version = 1 WHERE version IS NULL; ALTER TABLE summary_templates ALTER COLUMN version SET NOT NULL");
    }
});

test('een gewijzigde prompt hoogt de versie op', async () => {
    await tpl({ prompt: 'OUDE PROMPT', version: 3 });
    const out = await store.update('t-1', { prompt: 'NIEUWE PROMPT' });
    assert.strictEqual(out.prompt, 'NIEUWE PROMPT');
    assert.strictEqual(out.version, 4);
    assert.strictEqual(await versionOf(), 4);
});

test('hernoemen hoogt de versie NIET op', async () => {
    // The version says with which INSTRUCTION a summary was written. A different
    // name is the same instruction; raising it would suggest a change that did not
    // take place.
    await tpl({ name: 'Oud', version: 3 });
    const out = await store.update('t-1', { name: 'Nieuw' });
    assert.strictEqual(out.name, 'Nieuw');
    assert.strictEqual(await versionOf(), 3, 'geen versieophoging bij hernoemen');
});

test('standaard aan/uit zetten hoogt de versie NIET op', async () => {
    await tpl({ version: 3 });
    await tpl({ id: 't-old-default', is_default: true });
    const out = await store.update('t-1', { isDefault: true });
    assert.strictEqual(out.isDefault, true, 'de standaard is wel degelijk gezet');
    assert.strictEqual((await store.getById('t-old-default')).isDefault, false, 'de vorige standaard is gewist');
    assert.strictEqual(await versionOf(), 3, 'geen versieophoging bij standaard-zetten');
});

test('dezelfde prompt opnieuw opslaan hoogt de versie NIET op', async () => {
    // The editor fills in the prompt field; pressing Save without changing anything
    // sends back exactly the same text. That is not a new version.
    await tpl({ prompt: 'ZELFDE', version: 3 });
    await store.update('t-1', { prompt: 'ZELFDE' });
    assert.strictEqual(await versionOf(), 3, 'ongewijzigde tekst is geen nieuwe versie');
});

test('resolveDefaultTemplate geeft de RIJ terug, resolveDefaultPrompt alleen de tekst', async () => {
    // Stamping a note requires id + version; from a prompt string no id can be
    // recovered.
    await tpl({ id: 't-def', name: 'Standaard', prompt: 'DEFAULT PROMPT', is_default: true, version: 7 });
    await tpl({ id: 't-other', name: 'Ander', prompt: 'OTHER' });
    const t = await store.resolveDefaultTemplate({ userId: 'u-1' });
    assert.strictEqual(t.id, 't-def');
    assert.strictEqual(t.version, 7);
    assert.strictEqual(await store.resolveDefaultPrompt({ userId: 'u-1' }), 'DEFAULT PROMPT');
});

test('geen standaardsjabloon = null, niet een lege rij', async () => {
    await tpl({});
    assert.strictEqual(await store.resolveDefaultTemplate({ userId: 'u-1' }), null);
    assert.strictEqual(await store.resolveDefaultPrompt({ userId: 'u-1' }), null);
});
