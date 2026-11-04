/**
 * The Dutch for the builder's assistant column in plain words (handover.*).
 * Pins the silent failure modes: an English key without Dutch leaves English
 * on a Dutch screen, a Dutch key without an English one is never read.
 *
 * Run: node --test migrations/add-nl-handover-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-handover-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English handover.* key has Dutch (or is declared the same word), and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('handover.'));
    assert.ok(english.length > 0, 'the handover namespace is gone');
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS) && !SAME_AS_ENGLISH.includes(k)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('plain words: no builder jargon and no job title in what the person reads, and the reader is je', () => {
    for (const [k, v] of Object.entries({ ...NL_TRANSLATIONS, ...Object.fromEntries(Object.entries(GUI_DEFAULTS).filter(([key]) => key.startsWith('handover.'))) })) {
        assert.ok(!/\b(trigger|binding|finalize|finalise|dry run|consultant|adviseur|consultancy|expert)\b/i.test(v), `${k} uses a builder or banned word: ${v}`);
        assert.ok(!/\b(u|uw)\b/.test(v.replace(/\{[^}]*\}/g, '')), `${k} addresses the reader as u/uw`);
    }
    assert.strictEqual(NL_TRANSLATIONS['handover.vocab.trigger'], 'hoe het begint');
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'handover.card.activate': 'Eigen woorden' });
    assert.strictEqual(own.merged['handover.card.activate'], 'Eigen woorden');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
