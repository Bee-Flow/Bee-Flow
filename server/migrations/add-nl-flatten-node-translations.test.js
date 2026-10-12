/**
 * Dutch for "Flatten a list" (flatten_node.* and the five
 * automations.node.flatten.* node keys). Both silent failure modes are
 * pinned: a Dutch key with no English key is stored and never read, and an
 * English key with no Dutch value leaves one English sentence in a Dutch
 * editor.
 *
 * Run: node --test migrations/add-nl-flatten-node-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-flatten-node-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');

const NODE_KEYS = ['typeLabel', 'defaultLabel', 'label', 'desc', 'help'].map((k) => `automations.node.flatten.${k}`);

test('every English flatten_node key and the five node keys have a Dutch value', () => {
    const missing = Object.keys(GUI_DEFAULTS)
        .filter((k) => k.startsWith('flatten_node.') || k.startsWith('automations.node.flatten.'))
        .filter((k) => !NL_TRANSLATIONS[k]);
    assert.deepStrictEqual(missing, []);
    for (const k of NODE_KEYS) assert.ok(GUI_DEFAULTS[k] && NL_TRANSLATIONS[k], k);
    assert.ok(Object.keys(NL_TRANSLATIONS).length > 50);
});

test('placeholders survive translation', () => {
    const vars = (s) => (String(s).match(/\{\w+\}/g) || []).sort();
    for (const [key, nl] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(vars(nl), vars(GUI_DEFAULTS[key]), key);
    }
});

test('the house words: Flatten a list is Lijst plat maken, and no routine', () => {
    assert.strictEqual(NL_TRANSLATIONS['automations.node.flatten.typeLabel'], 'Lijst plat maken');
    for (const nl of Object.values(NL_TRANSLATIONS)) assert.doesNotMatch(nl, /routine/i);
});

test('it runs at boot, after the Condition node and before the routine → automation rename', () => {
    const at = BOOT_LIST.indexOf('add-nl-flatten-node-translations');
    assert.ok(at > BOOT_LIST.indexOf('add-nl-condition-node-translations'));
    assert.ok(at < BOOT_LIST.indexOf('rename-routine-i18n-2026-10'));
});
