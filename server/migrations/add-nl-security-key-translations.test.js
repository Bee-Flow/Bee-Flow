/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English security-key string
 * with no Dutch one is an English sentence in the middle of a Dutch sign-in
 * screen.
 *
 * Run: node --test migrations/add-nl-security-key-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-security-key-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED = (k) => k.startsWith('mfa.security_key') || [
    'mfa.attempts_exhausted', 'mfa.disable_removes_keys', 'mfa.use_security_key', 'mfa.use_security_key_instead',
    'mfa.use_security_key_setup', 'mfa.use_authenticator_setup', 'mfa.proof_required', 'mfa.sign_in_again',
    'mfa.add_authenticator', 'mfa.enable_confirm_with_key', 'mfa.confirm_with_recovery_or_key', 'mfa.confirm_with_key',
].includes(k);

test('every English security-key string has a Dutch one', () => {
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => OWNED(k) && !(k in NL_TRANSLATIONS));
    assert.deepStrictEqual(untranslated, []);
});
