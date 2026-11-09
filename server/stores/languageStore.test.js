// @typecheck
/**
 * languageStore.getAvailableLocales: the first read seeds the baseline locales.
 *
 * It handed back the module's own baseline array. addLocale and importLocale
 * push onto what they get, so on a fresh install whose first locale call was an
 * add, the added locale became part of the baseline for the life of the
 * process: the "baseline locales are always present" merge then put it back on
 * every read, and deleting that locale did not stick.
 *
 * Run: cd server && node --test stores/languageStore.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { recordDb } = require('../testUtils/routeHarness');

recordDb(); // no statement of this file reaches a database
const configStore = require('./configStore');

// The config table, in memory: the store's own reads and writes of it.
const saved = { getConfig: configStore.getConfig, setConfig: configStore.setConfig, deleteConfig: configStore.deleteConfig };
const table = new Map();
configStore.getConfig = async (key) => (table.has(key) ? JSON.parse(table.get(key)) : null);
configStore.setConfig = async (key, value) => { table.set(key, JSON.stringify(value)); return true; };
configStore.deleteConfig = async (key) => { return table.delete(key); };

const languageStore = require('./languageStore');

beforeEach(() => table.clear());
after(() => Object.assign(configStore, saved));

const codes = (list) => list.map((l) => l.code);

test('a locale added on the very first call can be deleted again', async () => {
    assert.deepEqual(codes(await languageStore.addLocale('es', 'Español')), ['en', 'nl', 'de', 'fr', 'es']);
    assert.deepEqual(codes(await languageStore.deleteLocale('es')), ['en', 'nl', 'de', 'fr']);
    assert.deepEqual(codes(await languageStore.getAvailableLocales()), ['en', 'nl', 'de', 'fr'], 'it stays deleted');
});

test('a later fresh seed is the baseline only', async () => {
    await languageStore.importLocale('pt', { name: 'Português' });
    table.clear();
    assert.deepEqual(codes(await languageStore.getAvailableLocales()), ['en', 'nl', 'de', 'fr']);
});

test('the baseline locales come back when one is missing, without a second default', async () => {
    table.set('i18n_locales', JSON.stringify([{ code: 'en', name: 'English', isDefault: true }]));
    const locales = await languageStore.getAvailableLocales();
    assert.deepEqual(codes(locales), ['en', 'nl', 'de', 'fr']);
    assert.equal(locales.filter((l) => l.isDefault).length, 1);
});
