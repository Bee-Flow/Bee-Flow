/**
 * The Dutch for the AI Act register's "Removed" filter. The generic rules
 * (registered in the boot ladder, no orphan, no English copied over,
 * placeholders) are in nlCatalogues.test.js; this pins that every key of the
 * round has Dutch.
 *
 * Run: node --test migrations/add-nl-ai-act-register-2026-11-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-ai-act-register-2026-11-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_KEYS = [
    'compliance.fw_pa_view_aria', 'compliance.fw_pa_view_current', 'compliance.fw_pa_view_removed', 'compliance.fw_pa_untitled',
    'compliance.fw_pa_deleted_automation', 'compliance.fw_pa_deleted_agent', 'compliance.fw_pa_state_trashed',
];

test('every key of this round exists in English and has Dutch, and nothing else is seeded', () => {
    for (const k of OWNED_KEYS) {
        assert.ok(k in GUI_DEFAULTS, `${k}: no English`);
        assert.ok(String(NL_TRANSLATIONS[k] || '').trim(), `${k}: no Dutch`);
    }
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).sort(), [...OWNED_KEYS].sort());
});

test('Dutch addresses the reader with "je", never "u"', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.ok(!/\b(u|uw)\b/i.test(v), `${k}: "${v}"`);
});
