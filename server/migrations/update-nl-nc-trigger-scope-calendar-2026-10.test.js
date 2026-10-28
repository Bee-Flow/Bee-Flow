/**
 * The Dutch hint of the Nextcloud colleagues switch, reworded for calendar
 * events (#407). Pins: the key exists in English, `was` is the Dutch that
 * really shipped, the new Dutch names calendars, a workspace's own wording
 * survives, a second run changes nothing, and boot runs it after the
 * catalogue whose Dutch it rewords.
 *
 * Run: node --test migrations/update-nl-nc-trigger-scope-calendar-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_REWORDED, applyNl } = require('./update-nl-nc-trigger-scope-calendar-2026-10');
const { NL_TRANSLATIONS: SHIPPED } = require('./add-nl-nc-trigger-scope-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('the reworded key exists in English, which names calendars too', () => {
    for (const key of Object.keys(NL_REWORDED)) {
        assert.ok(key in GUI_DEFAULTS, key);
        assert.match(GUI_DEFAULTS[key], /calendar/i);
        assert.match(NL_REWORDED[key].now, /agenda/);
    }
});

test('`was` is the Dutch that shipped, so existing installs match it', () => {
    for (const [key, { was }] of Object.entries(NL_REWORDED)) assert.ok(was.includes(SHIPPED[key]), key);
});

test('old shipped Dutch and a missing key get the new text; own wording stays; a second run changes nothing', () => {
    const key = 'nc_trigger_scope.hint';
    const fromOld = applyNl({ [key]: SHIPPED[key] });
    assert.strictEqual(fromOld.merged[key], NL_REWORDED[key].now);
    assert.strictEqual(fromOld.reworded, 1);
    assert.strictEqual(applyNl({}).merged[key], NL_REWORDED[key].now);
    assert.strictEqual(applyNl({ [key]: 'Eigen tekst' }).merged[key], 'Eigen tekst');
    assert.strictEqual(applyNl({ ...fromOld.merged }).reworded, 0);
});

test('boot runs it after the catalogue whose Dutch it rewords', () => {
    const src = require('node:fs').readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    const at = (name) => src.indexOf(`'${name}'`);
    assert.ok(at('update-nl-nc-trigger-scope-calendar-2026-10') > at('add-nl-nc-trigger-scope-2026-10-translations'));
    assert.ok(at('add-nl-nc-trigger-scope-2026-10-translations') > 0);
});
