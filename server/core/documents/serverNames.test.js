'use strict';

/**
 * The names the server gives what a person did not name (serverNames.mts): in
 * the reader's own language, English when the account has none or the lookup
 * fails.
 *
 * Run: cd server && node --test core/documents/serverNames.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { serverName, readerLocale } = require('./serverNames.mts');
const { translate } = require('../../i18n/translate');

const NL = require('../../i18n/defaults/nl/doc_server.json').translations;
// The catalogue as the server serves it: Dutch from the namespace file, English from the defaults.
const getStrings = async (code) => (code === 'nl' ? NL : {});
const deps = (locale) => ({
    getUser: async () => (locale === undefined ? null : { preferredLocale: locale }),
    translate: (l, key, vars) => translate(l, key, vars, { getStrings }),
});

test('a Dutch reader gets Dutch names; everybody else the English ones', async () => {
    assert.strictEqual(await serverName('u', 'doc_server.untitled_spreadsheet', {}, deps('nl')), 'Naamloze spreadsheet');
    assert.strictEqual(await serverName('u', 'doc_server.sheet_tab_name', { n: 2 }, deps('nl')), 'Blad2');
    assert.strictEqual(await serverName('u', 'doc_server.copy_name', { name: 'Plan' }, deps('nl')), 'Plan — kopie');
    assert.strictEqual(await serverName('u', 'doc_server.copy_name', { name: 'Plan' }, deps('en')), 'Plan — copy');
    assert.strictEqual(await serverName('u', 'doc_server.sheet_tab_name', { n: 3 }, deps(undefined)), 'Sheet3');
});

test('a failing lookup falls back to English instead of failing the request', async () => {
    assert.strictEqual(await readerLocale('u', { getUser: async () => { throw new Error('db down'); } }), 'en');
    const broken = { getUser: async () => ({ preferredLocale: 'nl' }), translate: async () => { throw new Error('catalogue down'); } };
    assert.strictEqual(await serverName('u', 'doc_server.copy_name', { name: 'Plan' }, broken), 'Plan — copy');
});
