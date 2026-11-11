/**
 * The Dutch for the code-step test cases. Together with
 * add-nl-automation-testing-translations this catalogue owns the WHOLE
 * automation_testing namespace: a new English key there without Dutch (or a
 * declaration that the Dutch is the English) fails here, so a Dutch screen
 * never shows English in the Tests tab.
 *
 * Run: node --test migrations/add-nl-automation-testing-cases-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-automation-testing-cases-translations');
const { NL_TRANSLATIONS: RUNNING } = require('./add-nl-automation-testing-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const NAMESPACE = 'automation_testing.';

test('every English automation_testing key has Dutch in one of the two catalogues', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith(NAMESPACE));
    assert.ok(english.length > 150, 'the automation_testing namespace is gone');
    const covered = new Set([...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH, ...Object.keys(RUNNING)]);
    assert.deepStrictEqual(english.filter((k) => !covered.has(k)), []);
});

test('the two catalogues split the namespace: no key in both', () => {
    const mine = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH];
    assert.ok(mine.every((k) => k.startsWith(NAMESPACE)), 'this catalogue holds only automation_testing keys');
    assert.deepStrictEqual(mine.filter((k) => k in RUNNING), []);
});

test('a check is a controle, a test case a testgeval, and the reader is je, never u', () => {
    assert.strictEqual(NL_TRANSLATIONS['automation_testing.assertions.add'], 'Controle toevoegen');
    assert.match(NL_TRANSLATIONS['automation_testing.save_as.action'], /testgeval/);
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/\b(u|uw)\b/i.test(v.replace(/\{[^}]*\}/g, '')), `${k} addresses the reader as u/uw`);
    }
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    for (const k of SAME_AS_ENGLISH) assert.ok(!(k in merged), `${k} is declared identical and must not be seeded`);
    const own = applyNl({ 'automation_testing.status.pass': 'Eigen woorden' });
    assert.strictEqual(own.merged['automation_testing.status.pass'], 'Eigen woorden');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
