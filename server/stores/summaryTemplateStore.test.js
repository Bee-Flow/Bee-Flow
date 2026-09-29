'use strict';

/**
 * Store-tests — sjabloonversie.
 *
 * Wat hier vastligt:
 *   1. `version` staat in de boot-DDL van deze store, via runDdl — niet in een
 *      migratiebestand en niet in een stille catch.
 *   2. Ophogen gebeurt bij een ECHTE promptwijziging, en alleen daar:
 *      hernoemen en standaard-zetten laten de versie staan.
 *   3. mapRow onderscheidt "geen versie bekend" (null) van 1.
 *   4. resolveDefaultTemplate geeft de RIJ terug — een prompt alleen is niet
 *      genoeg om een notitie mee te stempelen.
 *
 * Hermetisch: ../db is gestubd; geen Postgres.
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

    // Een rij van een replica die de ladder nog niet draaide. `1` invullen zou
    // een versie beweren die nergens vandaan komt.
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
    // De versie zegt met welke INSTRUCTIE een samenvatting geschreven is. Een
    // andere naam is dezelfde instructie; ophogen zou een verandering
    // suggereren die niet heeft plaatsgevonden.
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
    // De editor vult het promptveld voor; op Opslaan drukken zonder iets te
    // veranderen stuurt exact dezelfde tekst terug. Dat is geen nieuwe versie.
    oneRow = { id: 't-1', scope: 'user', name: 'Mijn', prompt: 'ZELFDE', version: 3 };
    await store.update('t-1', { prompt: 'ZELFDE' });
    assert.ok(!dbCalls.run.some((c) => /version =/.test(c.sql)), 'ongewijzigde tekst is geen nieuwe versie');
});

test('resolveDefaultTemplate geeft de RIJ terug, resolveDefaultPrompt alleen de tekst', async () => {
    // Een notitie stempelen vraagt om id + versie; uit een prompt-string is
    // geen id terug te winnen.
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
