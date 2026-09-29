/**
 * BFSF-276 — signup step 1 told everyone they were setting up an
 * "organisation", one screen before step 2 offers the personal-account
 * choice. The fix is a new account-type-agnostic key rendered until the user
 * has actually picked, so this pins the two silent ways that regresses:
 *
 *   - the English key disappears / gets renamed, and the wizard renders the
 *     raw key or falls back to the org copy again;
 *   - the English key survives but the NL migration doesn't cover it, and
 *     Dutch users (the primary audience) silently see English.
 *
 * Run: node --test migrations/add-nl-signup-welcome-neutral-translation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-signup-welcome-neutral-translation');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const KEY = 'signup.wizard_welcome_neutral';

test('the neutral welcome key exists in the English catalog', () => {
    assert.ok(KEY in GUI_DEFAULTS, `${KEY} must stay in server/i18n/defaults/en.js`);
});

test('the English copy is account-type-agnostic', () => {
    const en = GUI_DEFAULTS[KEY];
    assert.match(en, /account/i);
    // The whole point of BFSF-276: no "organisation" before the step-2 choice.
    assert.doesNotMatch(en, /organisation|organization/i);
});

test('the org-specific copy is still there for users who navigate back', () => {
    assert.ok('signup.wizard_welcome_org' in GUI_DEFAULTS);
    assert.ok('signup.wizard_welcome_consumer' in GUI_DEFAULTS);
});

test('every Dutch key in this migration exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('the neutral key has a non-blank Dutch value that is not the English one', () => {
    const nl = NL_TRANSLATIONS[KEY];
    assert.ok(String(nl || '').trim(), 'missing NL value — Dutch users would see English');
    assert.notStrictEqual(nl, GUI_DEFAULTS[KEY]);
    assert.doesNotMatch(nl, /organisatie/i);
});
