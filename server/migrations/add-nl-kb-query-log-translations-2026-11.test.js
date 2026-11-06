/**
 * The Dutch for the knowledge-base search log: every English key this round
 * added has Dutch, every Dutch key an English one, placeholders survive, the
 * user acknowledgement never says "toestemming", and a second run changes nothing.
 *
 * Run: node --test migrations/add-nl-kb-query-log-translations-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-kb-query-log-translations-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const isOurs = (k) => k.startsWith('knowledge.query_log.') || k === 'knowledge.tab_search_log'
    || k.startsWith('compliance.kql_') || /^compliance\.(rail|tab|dsr_discovery|aa_action)_kb_query_log/.test(k)
    || k.startsWith('studio_apps_edit.step_catalog.kb_log_') || k.startsWith('automations.node.kb_query_log.');

test('every English search-log key has Dutch, and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter(isOurs);
    assert.ok(english.length >= 200);
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('placeholders survive translation', () => {
    const names = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(names(v), names(GUI_DEFAULTS[k]), k);
    }
});

test('the acknowledgement is never worded as consent', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        if (k.startsWith('knowledge.query_log.ack_')) assert.ok(!/toestemming/i.test(v), k);
    }
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'knowledge.tab_search_log': 'Eigen log' });
    assert.strictEqual(own.merged['knowledge.tab_search_log'], 'Eigen log');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});

test('the boot ladder runs this catalogue', () => {
    const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');
    assert.ok(BOOT_LIST.includes('add-nl-kb-query-log-translations-2026-11'));
});
