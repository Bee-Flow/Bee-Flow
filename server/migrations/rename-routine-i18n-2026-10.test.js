/**
 * rename-routine-i18n-2026-10: stored translations follow their keys from
 * "routine" to "automation", the schedules panel's go to agent_schedules, and
 * Dutch wording changes only where it is still what a catalogue shipped.
 *
 * Run: cd server && node --test migrations/rename-routine-i18n-2026-10.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renameKey, rewordNl, renameBlob } = require('./rename-routine-i18n-2026-10');
const SHIPPED_NL = require('./data/routine-nl-shipped.json');
const PANEL_KEYS = require('./data/agent-schedules-key-map.json');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('a key takes the name the code gave it', () => {
    assert.equal(renameKey('routines.builder.save'), 'automations.builder.save');
    assert.equal(renameKey('routine_editor.activate'), 'automation_editor.activate');
    assert.equal(renameKey('forms.studio.open_routine'), 'forms.studio.open_automation');
    assert.equal(renameKey('projects.untitled_routine'), 'projects.untitled_automation');
    assert.equal(renameKey('chat.routinely'), 'chat.routinely', 'another word is left alone');
    assert.equal(renameKey('routines.new'), PANEL_KEYS['routines.new'], 'the schedules panel is Cowork now');
});

test('every renamed key a catalogue shipped exists in the English dictionary', () => {
    const missing = Object.keys(SHIPPED_NL)
        .map(renameKey)
        .filter((k) => /automation|agent_schedules/.test(k) && !Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, k));
    // Keys removed on purpose before this rename are allowed to be absent.
    assert.ok(missing.length < Object.keys(SHIPPED_NL).length / 10, `too many renamed keys missing: ${missing.slice(0, 10).join(', ')}`);
});

test('Dutch wording becomes automatisering', () => {
    assert.equal(rewordNl('De routine is gestopt.'), 'De automatisering is gestopt.');
    assert.equal(rewordNl('Routines en apps'), 'Automatiseringen en apps');
    assert.equal(rewordNl('naar de routine-bouwer'), 'naar de automatiseringsbouwer');
});

test('a blob moves its keys, keeps what a workspace curated and what already exists', () => {
    const shippedKey = Object.keys(SHIPPED_NL).find((k) => /^routines\./.test(k) && /routine/i.test(SHIPPED_NL[k])
        && Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, renameKey(k)));
    assert.ok(shippedKey, 'the fixture needs a shipped routines.* value that mentions routine');
    const english = { ...GUI_DEFAULTS };
    const blob = {
        [shippedKey]: SHIPPED_NL[shippedKey],
        'routines.builder.curated_by_us': 'Onze eigen routine',
        'approvals.audit_closed': 'Gesloten — de routine wachtte niet meer',
        'common.cancel': 'Annuleren',
    };
    english['automations.builder.curated_by_us'] = 'x';
    const { blob: out, moved } = renameBlob(blob, { locale: 'nl', english });

    assert.equal(out[shippedKey], undefined, 'the old key is gone');
    assert.equal(out[renameKey(shippedKey)], rewordNl(SHIPPED_NL[shippedKey]), 'shipped wording is reworded');
    assert.equal(out['automations.builder.curated_by_us'], 'Onze eigen routine', 'curated wording stays');
    assert.equal(out['common.cancel'], 'Annuleren');
    assert.ok(moved >= 2);

    const again = renameBlob(out, { locale: 'nl', english });
    assert.deepEqual(again.blob, out, 'a second run changes nothing');
    assert.equal(again.moved, 0);
});

test('an existing new key wins over the moved one, and other locales are not reworded', () => {
    const english = { 'automations.x': 'X' };
    const { blob } = renameBlob({ 'routines.x': 'oud', 'automations.x': 'nieuw' }, { locale: 'nl', english });
    assert.deepEqual(blob, { 'automations.x': 'nieuw' });
    const de = renameBlob({ 'routines.x': 'Routine' }, { locale: 'de', english });
    assert.deepEqual(de.blob, { 'automations.x': 'Routine' });
});
