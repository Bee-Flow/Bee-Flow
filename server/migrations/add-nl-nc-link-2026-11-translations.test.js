/**
 * The Dutch for linking a Nextcloud account after a normal sign-in. The
 * generic rules (registered in the boot ladder, no orphan, no English copied
 * over, placeholders) are in nlCatalogues.test.js; this pins that every key
 * of the round has Dutch.
 *
 * Run: node --test migrations/add-nl-nc-link-2026-11-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-nc-link-2026-11-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_KEYS = [
    'app.nc_link_required_link', 'app.nc_link_required_hint',
    'mfa.nc_link_title', 'mfa.nc_link_body', 'mfa.nc_link_button', 'mfa.nc_link_done', 'mfa.nc_link_failed', 'mfa.nc_link_other_account',
    'integ.org_nc_pairing_shown_once',
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
