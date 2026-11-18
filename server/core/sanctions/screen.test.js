// @typecheck
'use strict';
/**
 * Folding, keys, name similarity and the screening's scores (normalize.mts, match.mts, screen.mts).
 * Run: cd server && node --test core/sanctions/screen.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { foldText, nameTokens, nameKeys, skeleton, countryCode, countryKey, birthDateKey } = require('./normalize.mts');
const { jaroWinkler, nameSimilarity } = require('./match.mts');
const { screenCandidates, screenOptions, birthDateAdjustment } = require('./screen.mts');

test('folding: diacritics, ß and ø, Cyrillic transliterated, punctuation as spaces', () => {
    assert.strictEqual(foldText('Qoussaï Al-Tikriti'), 'qoussai al tikriti');
    assert.strictEqual(foldText('Straße Ørsted'), 'strasse orsted');
    assert.strictEqual(foldText('Петра Пробеерсма'), 'petra probeersma');
    assert.deepStrictEqual(nameTokens('Example Trading Co., Ltd.'), ['example', 'trading']);
    assert.deepStrictEqual(nameTokens('The Company'), ['the', 'company'], 'a name of legal-form words only keeps them');
});

test('keys: spellings of one name share a skeleton key', () => {
    assert.strictEqual(skeleton('mohammed'), skeleton('muhammad'));
    assert.strictEqual(skeleton('mohamed'), skeleton('muhammad'));
    assert.strictEqual(skeleton('qusay'), skeleton('kusay'));
    assert.ok(nameKeys('Mohammed Ali').includes(`s:${skeleton('muhammad')}`));
    assert.deepStrictEqual(nameKeys('A'), [], 'a one-letter token has no key');
});

test('countries and birth dates in the forms the lists use', () => {
    assert.strictEqual(countryCode('Netherlands'), 'NL');
    assert.strictEqual(countryCode('nl'), 'NL');
    assert.strictEqual(countryCode('Russian Federation'), 'RU');
    assert.strictEqual(countryKey('00'), null);
    assert.strictEqual(countryKey('Atlantis'), 'atlantis');
    assert.strictEqual(birthDateKey('1970-5-4'), '1970-05-04');
    assert.strictEqual(birthDateKey('10-10-1998'), '1998-10-10');
    assert.strictEqual(birthDateKey('02 Feb 1975'), '1975-02-02');
    assert.strictEqual(birthDateKey('dd/mm/1945'), '1945');
    assert.strictEqual(birthDateKey('unknown'), null);
});

test('similarity: identical 1, word order free, a different name low', () => {
    assert.strictEqual(jaroWinkler('martha', 'martha'), 1);
    assert.ok(Math.abs(jaroWinkler('martha', 'marhta') - 0.961) < 0.001);
    assert.strictEqual(nameSimilarity(['saddam', 'hussein'], ['hussein', 'saddam']), 1);
    assert.ok(nameSimilarity(['jan', 'jansen'], ['piet', 'pietersen']) < 0.7);
    const partial = nameSimilarity(['qusay', 'hussein'], ['qusay', 'saddam', 'hussein', 'al', 'tikriti']);
    assert.ok(partial > 0.8 && partial < 1, `partial ${partial}`);
});

const row = (over = {}) => ({
    listId: 'eu_fsf', entityId: '101', kind: 'person', primaryName: 'Jöran Testmann', name: 'Jöran Testmann',
    birthDates: ['1970-05-04'], countries: ['NL'], programmes: ['TST'], reference: 'EU.1.11', url: 'https://example.test/eu', ...over,
});

test('screening: best alias per entity, birth date and country move the score, sorted and capped', () => {
    const rows = [row(), row({ name: 'Joran Testman' }), row({ listId: 'un_sc', entityId: '9', name: 'Joran Testmann', birthDates: ['1955'], countries: [] })];
    const out = screenCandidates({ name: 'Joran Testmann', birthDate: '1970-05-04', country: 'Netherlands' }, rows);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].listId, 'eu_fsf');
    assert.strictEqual(out[0].score, 1);
    assert.deepStrictEqual(out[0].reasons, ['same birth date', 'same country']);
    assert.strictEqual(out[1].listId, 'un_sc');
    assert.ok(out[1].score < out[0].score, 'a different birth year lowers the namesake');
    assert.deepStrictEqual(out[1].reasons, ['different birth year']);
    assert.strictEqual(screenCandidates({ name: 'Joran Testmann' }, rows, { maxResults: 1 }).length, 1);
    assert.deepStrictEqual(screenCandidates({ name: 'Joran Testmann' }, rows, { lists: ['un_sc'] }).map((c) => c.listId), ['un_sc']);
    assert.deepStrictEqual(screenCandidates({ name: 'Completely Different' }, rows), []);
    assert.deepStrictEqual(screenCandidates({ name: '' }, rows), []);
});

test('options are clamped, a year-only list date one year off counts as near', () => {
    assert.deepStrictEqual(screenOptions({ minScore: 0.1, maxResults: 500 }), { minScore: 0.5, maxResults: 50, lists: null });
    assert.strictEqual(birthDateAdjustment('1971-01-01', ['1970']).delta, 0.04);
    assert.strictEqual(birthDateAdjustment('1980', ['1970-01-01']).delta, -0.15);
    assert.strictEqual(birthDateAdjustment(null, ['1970']).delta, 0);
});

test('one word against a longer name stays below the default threshold', () => {
    assert.ok(nameSimilarity(['hussein'], ['saddam', 'hussein']) <= 0.8);
    assert.ok(nameSimilarity(['saddam', 'hussein'], ['hussein']) <= 0.8);
    assert.strictEqual(nameSimilarity(['cimex'], ['cimex']), 1);
});
