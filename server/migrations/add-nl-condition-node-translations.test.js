/**
 * Dutch for the Condition node (condition_node.*). Both silent failure modes
 * are pinned: a Dutch key with no English key is stored and never read, and
 * an English key with no Dutch value leaves one English sentence in a Dutch
 * editor.
 *
 * Run: node --test migrations/add-nl-condition-node-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-condition-node-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');

const PREFIX = 'condition_node.';

test('every Dutch key has an English key', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('every English condition_node key has a Dutch value', () => {
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith(PREFIX) && !NL_TRANSLATIONS[k]);
    assert.deepStrictEqual(missing, []);
    assert.ok(Object.keys(NL_TRANSLATIONS).length > 100);
});

test('placeholders survive translation', () => {
    for (const [key, nl] of Object.entries(NL_TRANSLATIONS)) {
        const vars = (s) => (String(s).match(/\{\w+\}/g) || []).sort();
        assert.deepStrictEqual(vars(nl), vars(GUI_DEFAULTS[key]), key);
    }
});

test('the house words: Condition is Voorwaarde, Otherwise is Anders', () => {
    assert.strictEqual(NL_TRANSLATIONS['condition_node.otherwise.label'], 'Anders');
    assert.match(NL_TRANSLATIONS['condition_node.stale.follow'], /Voorwaarde/);
    assert.match(NL_TRANSLATIONS['condition_node.outputs.keep_rest'], /“Anders”/);
});

test('a noun from the data never needs a Dutch article or compound', () => {
    // {name}/{item}/{unit} are list words from the data ("item", "messages"):
    // "elke item" and "voorbeeld-messages" are wrong, so no sentence puts a
    // gendered word in front of one or glues one onto a Dutch word.
    const gendered = /\b(elke|elk|ieder|iedere|geen enkele|geen enkel|de|het|die|dat|welke|welk)\s+\{(name|item|unit)\}/i;
    const glued = /\w-\{(name|item|unit)\}/;
    for (const [key, nl] of Object.entries(NL_TRANSLATIONS)) {
        assert.doesNotMatch(nl, gendered, key);
        assert.doesNotMatch(nl, glued, key);
    }
    assert.strictEqual(NL_TRANSLATIONS['condition_node.group.item'], 'Velden per {name}');
    assert.strictEqual(NL_TRANSLATIONS['condition_node.canvas.kept'], '{kept} van {total} doorgelaten');
});

test('it runs at boot, before the routine → automation rename', () => {
    const at = BOOT_LIST.indexOf('add-nl-condition-node-translations');
    assert.ok(at >= 0);
    assert.ok(at < BOOT_LIST.indexOf('rename-routine-i18n-2026-10'));
});
