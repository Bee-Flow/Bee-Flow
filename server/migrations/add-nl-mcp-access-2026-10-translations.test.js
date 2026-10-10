/**
 * The Dutch for the MCP access screens (2026-10). A Dutch key without an
 * English counterpart is stored and never read; an English key without Dutch
 * leaves one English sentence in a Dutch screen.
 *
 * Run: node --test migrations/add-nl-mcp-access-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-mcp-access-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIX = 'mcp_access.';

test('every English mcp_access key has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => k.startsWith(OWNED_PREFIX) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('no dashes as punctuation in the new text, in either language', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
        assert.ok(!/[–—]/.test(GUI_DEFAULTS[k]), `${k} (en) uses a dash`);
    }
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept, a second run changes nothing', () => {
    const first = applyNl({});
    assert.strictEqual(first.added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ [Object.keys(NL_TRANSLATIONS)[0]]: 'Eigen woord' });
    assert.strictEqual(own.merged[Object.keys(NL_TRANSLATIONS)[0]], 'Eigen woord');
    const second = applyNl({ ...first.merged });
    assert.strictEqual(second.added, 0);
});
