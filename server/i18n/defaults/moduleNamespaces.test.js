// @typecheck
'use strict';
/**
 * i18n/defaults/moduleNamespaces: a Dutch catalogue of the core seeds no key of a namespace whose
 * module is not here, and with every module present it changes nothing.
 *
 *  - moduleNamespaces.json agrees with scripts/module-map.json, every module visible: every
 *    i18n/defaults/en/<namespace>.js a module owns is recorded under that module, nothing else is.
 *  - The dictionary is a double here (which namespaces are in the tree), so both answers are
 *    tested in either mode; the store is stores/languageStore.js on an in-memory config table.
 *
 * Run: cd server && node --test i18n/defaults/moduleNamespaces.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const REPO = path.resolve(__dirname, '..', '..', '..');
const { MODULE_NAMESPACES, presentOnly, keepAbsentNamespaces, absentNamespacesSalt } = require('./moduleNamespaces');

const { recordDb } = require('../../testUtils/routeHarness');

recordDb(); // no statement of this file reaches a database
const configStore = require('../../stores/configStore');

const table = new Map();
const savedMutate = configStore.mutateConfig;
configStore.mutateConfig = async (/** @type {string} */ key, /** @type {(v: unknown) => unknown} */ fn) => { table.set(key, fn(table.get(key) ?? null)); };
const languageStore = require('../../stores/languageStore');

const EN_FILE = require.resolve('./en');
const realEn = require.cache[EN_FILE];

/**
 * The dictionary as a double: which namespaces have their English file in the tree.
 * @param {string[]} present
 */
function treeHas(present) {
    require.cache[EN_FILE] = /** @type {NodeJS.Module} */ (/** @type {unknown} */ ({
        id: EN_FILE, filename: EN_FILE, loaded: true,
        exports: { LISTED_NAMESPACES: present, DISCOVERED_NAMESPACES: [] },
    }));
}
const EVERY_NAMESPACE = ['chat', 'common', ...Object.keys(MODULE_NAMESPACES)];
const coreMode = () => treeHas(['chat', 'common']);

beforeEach(() => { table.clear(); treeHas(EVERY_NAMESPACE); });
after(() => {
    configStore.mutateConfig = savedMutate;
    if (realEn) require.cache[EN_FILE] = realEn; else delete require.cache[EN_FILE];
});

test('moduleNamespaces.json names exactly the namespaces the map gives to a module', async () => {
    const { loadModuleMap } = await import(path.join(REPO, 'scripts', 'module-map.mjs'));
    const map = loadModuleMap();
    /** @type {Record<string, string>} */
    const expected = {};
    for (const f of map.files('server')) {
        const m = /^i18n\/defaults\/en\/([A-Za-z0-9_]+)\.js$/.exec(f.treePath);
        if (m && f.owner) expected[/** @type {string} */ (m[1])] = f.owner;
    }
    assert.deepEqual({ ...MODULE_NAMESPACES }, expected, 'regenerate the record from scripts/module-map.json');
});

test('every module namespace present: the writes go through unchanged, the salt is empty', () => {
    const translations = { 'chat.a': 'A', 'automations.b': 'B' };
    assert.equal(presentOnly(translations), translations, 'the same object');
    const next = { 'automations.b': 'B2' };
    assert.equal(keepAbsentNamespaces({ 'automations.b': 'B' }, next), next);
    assert.equal(absentNamespacesSalt(), '');
});

test('a module namespace absent: its keys are not seeded, not changed and not removed', () => {
    coreMode();
    assert.deepEqual(presentOnly({ 'chat.a': 'A', 'automations.b': 'B', 'routines.c': 'C' }), { 'chat.a': 'A', 'routines.c': 'C' },
        'a namespace no module owns is never absent');
    const current = { 'automations.kept': 'oud', 'chat.x': 'X' };
    const next = { 'chat.x': 'X2', 'automations.new': 'nieuw' };
    assert.deepEqual(keepAbsentNamespaces(current, next), { 'chat.x': 'X2', 'automations.kept': 'oud' });
    assert.match(absentNamespacesSalt(), /^absent-i18n-namespaces:.*\bautomations\b/);
});

test('languageStore.addMissingGUITranslations seeds the core keys only, and counts what it added', async () => {
    coreMode();
    const { added } = await languageStore.addMissingGUITranslations('nl', { 'chat.a': 'A', 'compliance.b': 'B' });
    assert.equal(added, 1);
    assert.deepEqual(table.get('i18n_gui_nl'), { 'chat.a': 'A' });
});

test('languageStore.addMissingGUITranslations with every module present seeds every key', async () => {
    const { added } = await languageStore.addMissingGUITranslations('nl', { 'chat.a': 'A', 'compliance.b': 'B' });
    assert.equal(added, 2);
    assert.deepEqual(table.get('i18n_gui_nl'), { 'chat.a': 'A', 'compliance.b': 'B' });
});

test('languageStore.mutateGUITranslations leaves an absent module namespace as stored', async () => {
    table.set('i18n_gui_nl', { 'compliance.b': 'oud', 'chat.a': 'A' });
    coreMode();
    await languageStore.mutateGUITranslations('nl', (cur) => {
        delete cur['compliance.b'];
        cur['compliance.c'] = 'nieuw';
        cur['chat.a'] = 'A2';
        return cur;
    });
    assert.deepEqual(table.get('i18n_gui_nl'), { 'chat.a': 'A2', 'compliance.b': 'oud' });
});
