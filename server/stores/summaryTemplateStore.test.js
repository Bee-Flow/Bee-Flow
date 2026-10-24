'use strict';

/**
 * Store tests — template version.
 *
 * What is pinned here:
 *   1. `version` is in the boot DDL of this store, via runDdl — not in a migration
 *      file and not in a silent catch.
 *   2. Raising happens on a REAL prompt change, and only there: renaming and
 *      setting as default leave the version as it is.
 *   3. mapRow distinguishes "no version known" (null) from 1.
 *   4. resolveDefaultTemplate returns the ROW — a prompt alone is not enough to
 *      stamp a note with.
 *
 * Hermetic: ../db is stubbed; no Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/summaryTemplateStore.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

const dbCalls = { exec: [], run: [], getOne: [], getAll: [] };
let oneRow = null;      // wat getOne teruggeeft
let allRows = [];       // wat getAll teruggeeft

const dbStub = {
    async exec(sql) { dbCalls.exec.push(sql); return { rowCount: 0 }; },
    async run(sql, params) { dbCalls.run.push({ sql, params }); return { rowCount: 1 }; },
    async getOne(sql, params) { dbCalls.getOne.push({ sql, params }); return oneRow; },
    async getAll(sql, params) { dbCalls.getAll.push({ sql, params }); return allRows; },
};

const STORES_DIR = path.sep + 'stores' + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(STORES_DIR) && request === '../db') {
        return path.join(__dirname, '__stub_db_sumtpl__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
{
    const full = path.join(__dirname, '__stub_db_sumtpl__.js');
    require.cache[full] = { id: full, filename: full, loaded: true, exports: dbStub };
}

const store = require('./summaryTemplateStore');
const flat = (s) => String(s).replace(/\s+/g, ' ');

test.beforeEach(() => {
    dbCalls.run.length = 0;
    dbCalls.getOne.length = 0;
    dbCalls.getAll.length = 0;
    oneRow = null;
    allRows = [];
});

test('version zit in de boot-DDL — CREATE TABLE én een idempotente ALTER', async () => {
    await store.getById('whatever');
    const all = dbCalls.exec.join('\n');
    assert.match(all, /CREATE TABLE IF NOT EXISTS summary_templates[\s\S]*version INTEGER NOT NULL DEFAULT 1/,
        'verse installaties krijgen de kolom uit de CREATE TABLE');
    assert.match(all, /ALTER TABLE summary_templates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1/,
        'bestaande installaties krijgen hem uit de ladder');
});

test('elke SELECT haalt version op — anders kan geen enkele lezer hem tonen', async () => {
    await store.getById('t-1');
    assert.match(dbCalls.getOne.at(-1).sql, /\bversion\b/);
    await store.listVisible({ userId: 'u-1' });
    assert.match(dbCalls.getAll.at(-1).sql, /\bversion\b/);
});

test('mapRow onderscheidt "geen versie" van versie 1', async () => {
    oneRow = { id: 't-1', scope: 'user', name: 'Mijn', prompt: 'P', version: 4 };
    assert.strictEqual((await store.getById('t-1')).version, 4);

    // A row from a replica that has not run the ladder yet. Filling in `1` would
    // claim a version that comes from nowhere.
    for (const raw of [undefined, null, 0, 'nope']) {
        oneRow = { id: 't-1', scope: 'user', name: 'Mijn', prompt: 'P', version: raw };
        assert.strictEqual((await store.getById('t-1')).version, null, `version=${String(raw)} → null`);
    }
});

test('een gewijzigde prompt hoogt de versie op', async () => {
    oneRow = { id: 't-1', scope: 'user', name: 'Mijn', prompt: 'OUDE PROMPT', version: 3 };
    await store.update('t-1', { prompt: 'NIEUWE PROMPT' });
    const write = dbCalls.run.find((c) => /UPDATE summary_templates SET/.test(c.sql));
    assert.ok(write, 'er is geschreven');
    assert.match(flat(write.sql), /version = COALESCE\(version, 1\) \+ 1/);
    assert.ok(write.params.includes('NIEUWE PROMPT'));
});

test('hernoemen hoogt de versie NIET op', async () => {
    // The version says with which INSTRUCTION a summary was written. A different
    // name is the same instruction; raising it would suggest a change that did not
    // take place.
    oneRow = { id: 't-1', scope: 'user', name: 'Oud', prompt: 'P', version: 3 };
    await store.update('t-1', { name: 'Nieuw' });
    const write = dbCalls.run.find((c) => /UPDATE summary_templates SET/.test(c.sql));
    assert.ok(write);
    assert.ok(!/version =/.test(write.sql), 'geen versieophoging bij hernoemen');
});

test('standaard aan/uit zetten hoogt de versie NIET op', async () => {
    oneRow = { id: 't-1', scope: 'user', userId: 'u-1', name: 'Mijn', prompt: 'P', version: 3 };
    await store.update('t-1', { isDefault: true });
    const write = dbCalls.run.find((c) => /UPDATE summary_templates SET/.test(c.sql) && /is_default = TRUE/.test(c.sql));
    assert.ok(write, 'de standaard is wel degelijk gezet');
    assert.ok(!dbCalls.run.some((c) => /version =/.test(c.sql)), 'geen versieophoging bij standaard-zetten');
});

test('dezelfde prompt opnieuw opslaan hoogt de versie NIET op', async () => {
    // The editor fills in the prompt field; pressing Save without changing anything
    // sends back exactly the same text. That is not a new version.
    oneRow = { id: 't-1', scope: 'user', name: 'Mijn', prompt: 'ZELFDE', version: 3 };
    await store.update('t-1', { prompt: 'ZELFDE' });
    assert.ok(!dbCalls.run.some((c) => /version =/.test(c.sql)), 'ongewijzigde tekst is geen nieuwe versie');
});

test('resolveDefaultTemplate geeft de RIJ terug, resolveDefaultPrompt alleen de tekst', async () => {
    // Stamping a note requires id + version; from a prompt string no id can be
    // recovered.
    allRows = [{ id: 't-def', scope: 'user', user_id: 'u-1', name: 'Standaard', prompt: 'DEFAULT PROMPT', is_default: true, version: 7 }];
    const tpl = await store.resolveDefaultTemplate({ userId: 'u-1' });
    assert.strictEqual(tpl.id, 't-def');
    assert.strictEqual(tpl.version, 7);
    assert.strictEqual(await store.resolveDefaultPrompt({ userId: 'u-1' }), 'DEFAULT PROMPT');
});

test('geen standaardsjabloon = null, niet een lege rij', async () => {
    allRows = [];
    assert.strictEqual(await store.resolveDefaultTemplate({ userId: 'u-1' }), null);
    assert.strictEqual(await store.resolveDefaultPrompt({ userId: 'u-1' }), null);
});
