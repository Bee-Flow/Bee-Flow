'use strict';

/**
 * `tokenizeText` — a person found once is replaced everywhere (BFSF-269,
 * BFSF-300).
 *
 * The leak: the detector judges each mention separately and misses some of
 * them (in a long dossier: a child's first name in half its mentions; in a
 * contact table: the display name next to split name cells it did find).
 * Alias coalescing then folds what WAS found onto the full name, so the token
 * map holds only "Hendrik Vos" and nothing downstream knows that the bare
 * "Hendrik" three paragraphs up is him. That mention went to the provider as
 * plain text.
 *
 * The sweep inside tokenizeText replaces every further, word-bounded
 * occurrence of a found name and of its distinctive parts, and the alias index
 * gives each the right token: the person's own when the part fits one person,
 * a separate one when it fits two. Which text is swept is pinned in
 * nameSweep.test.js; this file pins what reaches the model and the token map.
 *
 * All names and addresses are synthetic.
 *
 * Run: cd server && node --test core/privacy/piiDetection/tokenizer.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { tokenizeText } = require('./tokenizer');
const { restoreTokens } = require('./tokenRestore');

/** A detected span for the first occurrence of `value` at or after `from`. */
function span(text, value, category = 'Person', from = 0) {
    const offset = text.indexOf(value, from);
    assert.ok(offset >= 0, `fixture: "${value}" not in text`);
    return { text: value, category, label: category === 'Person' ? 'Person Name' : category, offset, length: value.length, confidence: 0.9 };
}

const count = (text, needle) => text.split(needle).length - 1;

test('a name detected once is replaced at every occurrence, on one token', () => {
    const text = 'Hendrik Vos belde maandag. Op dinsdag mailde Hendrik Vos opnieuw, en Hendrik Vos tekende vrijdag.';
    const { tokenizedText, tokenMap, sweptEntities } = tokenizeText(text, [span(text, 'Hendrik Vos')]);

    assert.deepStrictEqual(tokenMap, { '[person_1]': 'Hendrik Vos' });
    assert.strictEqual(tokenizedText,
        '[person_1] belde maandag. Op dinsdag mailde [person_1] opnieuw, en [person_1] tekende vrijdag.');
    assert.strictEqual(sweptEntities.length, 2, 'the two mentions the detector missed are reported');
    assert.strictEqual(restoreTokens(tokenizedText, tokenMap), text);
});

test('a first name and a surname found only inside the full name are replaced on their own too', () => {
    const text = 'Brief van Hendrik Vos. Hendrik schrijft dat Vos het huis wil houden.';
    const { tokenizedText, tokenMap } = tokenizeText(text, [span(text, 'Hendrik Vos')]);

    assert.deepStrictEqual(tokenMap, { '[person_1]': 'Hendrik Vos' },
        'the bare parts fold onto the one person they belong to');
    assert.strictEqual(tokenizedText, 'Brief van [person_1]. [person_1] schrijft dat [person_1] het huis wil houden.');
});

test('parts shared by two found people are still replaced, on a token of their own', () => {
    // The ambiguity guard decides which token a part gets, never whether it
    // is replaced: two different Joris must not become one person, and the
    // bare "Joris" must not reach the model either.
    const text = 'Joris Hoekstra en Joris Mulder waren er. Joris nam het woord; Hoekstra zweeg.';
    const { tokenizedText, tokenMap } = tokenizeText(text, [
        span(text, 'Joris Hoekstra'), span(text, 'Joris Mulder'),
    ]);

    assert.deepStrictEqual(Object.values(tokenMap).sort(), ['Joris', 'Joris Hoekstra', 'Joris Mulder']);
    assert.ok(!/Joris|Hoekstra|Mulder/.test(tokenizedText), `plain text left: ${tokenizedText}`);
    const tokenOf = (v) => Object.keys(tokenMap).find(k => tokenMap[k] === v);
    assert.ok(tokenizedText.endsWith(`${tokenOf('Joris')} nam het woord; ${tokenOf('Joris Hoekstra')} zweeg.`),
        'the unambiguous surname still lands on its own person');
});

test('a name from an earlier turn is replaced when this turn only mentions part of it', () => {
    // Turn 2: the detector found the address but not the bare first name.
    const existing = { '[person_1]': 'Daan Verbeek', '[email_1]': 'daan@example.test' };
    const text = 'Stuur het naar daan@example.test, Daan wacht erop.';
    const { tokenizedText, tokenMap, sweptEntities } = tokenizeText(text, [span(text, 'daan@example.test', 'Email')], existing);

    assert.strictEqual(tokenizedText, 'Stuur het naar [email_1], [person_1] wacht erop.');
    assert.strictEqual(tokenMap['[person_1]'], 'Daan Verbeek', 'the existing token is reused, not re-minted');
    assert.deepStrictEqual(sweptEntities.map(e => e.label), ['Person Name']);
});

test('a first name that is also an ordinary word keeps its ordinary use', () => {
    const text = 'Will Hartman sent the draft. Will you check it today? I will reply. Thanks, Will.';
    const { tokenizedText } = tokenizeText(text, [span(text, 'Will Hartman')]);
    assert.strictEqual(tokenizedText,
        '[person_1] sent the draft. Will you check it today? I will reply. Thanks, [person_1].');
});

test('the typed-literal rule of BFSF-358B still holds next to a known full name', () => {
    // The whole input is one value somebody typed; it must leave the platform
    // exactly as typed even though the conversation knows the full name.
    const existing = { '[person_1]': 'Femke Mulder' };
    const query = 'Femke';
    const { tokenizedText, tokenMap } = tokenizeText(query, [span(query, 'Femke')], existing);

    assert.deepStrictEqual(Object.values(tokenMap), ['Femke']);
    assert.strictEqual(restoreTokens(tokenizedText, { ...existing, ...tokenMap }), query);
});

test('a contact row: split name cells get the display name\'s token, the particle cell stays', () => {
    // One value per line, as pasted from a spreadsheet. The detector found the
    // display names but none of the split cells.
    const text = [
        '#', 'Weergavenaam', 'Voornaam', 'Tussenvoegsel', 'Achternaam', 'Plaats',
        '1', 'Ruben van Leeuwen', 'Ruben', 'van', 'Leeuwen', 'Zwolle',
        '2', 'Femke Mulder', 'Femke', '', 'Mulder', 'Assen',
    ].join('\n');
    const { tokenizedText, tokenMap } = tokenizeText(text, [
        span(text, 'Ruben van Leeuwen'), span(text, 'Femke Mulder'),
    ]);

    assert.ok(!/Ruben|Leeuwen|Femke|Mulder/.test(tokenizedText), `plain name left: ${tokenizedText}`);
    assert.strictEqual(count(tokenizedText, '\n'), count(text, '\n'), 'no cell may be merged away');
    assert.deepStrictEqual(Object.values(tokenMap).sort(), ['Femke Mulder', 'Ruben van Leeuwen'],
        'one token per person, and the bare "van" cell is not a token');
    const lines = tokenizedText.split('\n');
    assert.strictEqual(lines[9], 'van', 'the tussenvoegsel cell identifies nobody and stays');
    assert.strictEqual(lines[7], lines[8]);
    assert.strictEqual(lines[7], lines[10]);
    // Expected trade-off of one token per person: a restored cell carries the
    // full name, not the part that was written there.
    assert.strictEqual(restoreTokens(lines[8], tokenMap), 'Ruben van Leeuwen');
});

test('a tab-separated contact row keeps every cell, with the split name cells tokenised', () => {
    const header = 'Weergavenaam\tVoornaam\tTussenvoegsel\tAchternaam\tPlaats';
    const text = `${header}\nRuben van Leeuwen\tRuben\tvan\tLeeuwen\tZwolle`;
    const { tokenizedText, tokenMap } = tokenizeText(text, [span(text, 'Ruben van Leeuwen')]);

    assert.strictEqual(tokenizedText, `${header}\n[person_1]\t[person_1]\tvan\t[person_1]\tZwolle`);
    assert.deepStrictEqual(tokenMap, { '[person_1]': 'Ruben van Leeuwen' });
});

test('a contact row: an undetected "Surname, First name" display name gets the split cells\' token', () => {
    const text = 'Van Leeuwen, Ruben\nRuben\nvan\nLeeuwen\nZwolle';
    // The detector found the split cells, as one span over three lines. Since
    // BFSF-299 that span is cut per cell: each name cell gets its own token,
    // the bare "van" cell identifies nobody and stays, and no line is merged.
    const { tokenizedText, tokenMap } = tokenizeText(text, [span(text, 'Ruben\nvan\nLeeuwen')]);

    assert.ok(!/Ruben|Leeuwen/.test(tokenizedText), `plain name left: ${tokenizedText}`);
    assert.deepStrictEqual(Object.values(tokenMap).sort(), ['Leeuwen', 'Ruben'], JSON.stringify(tokenMap));
    assert.strictEqual(count(tokenizedText, '\n'), count(text, '\n'), 'no cell may be merged away');
    assert.strictEqual(tokenizedText.split('\n')[2], 'van');
});

test('a surname in an organisation name that was not detected as one is replaced too', () => {
    const text = 'Contact: Femke Mulder, Mulder Advies B.V.';
    const { tokenizedText } = tokenizeText(text, [span(text, 'Femke Mulder')]);
    assert.strictEqual(tokenizedText, 'Contact: [person_1], [person_1] Advies B.V.');
});

test('a detected organisation keeps its own token; its words are not swept into it', () => {
    const text = 'Femke Mulder werkt bij Mulder Advies.';
    const { tokenizedText, tokenMap } = tokenizeText(text, [
        span(text, 'Femke Mulder'), span(text, 'Mulder Advies', 'Organization'),
    ]);
    assert.strictEqual(tokenizedText, '[person_1] werkt bij [organization_1].');
    assert.deepStrictEqual(tokenMap, { '[person_1]': 'Femke Mulder', '[organization_1]': 'Mulder Advies' });
});

test('a placeholder is the category id in lower case plus an index (the documented format)', () => {
    // docs/docs/features/privacy-shield.md shows these: an IBAN is not `[iban_1]`.
    const text = 'IBAN NL91ABNA0417164300, bel 0612345678.';
    const { tokenizedText, tokenMap } = tokenizeText(text, [
        span(text, 'NL91ABNA0417164300', 'InternationalBankingAccountNumber'),
        span(text, '0612345678', 'PhoneNumber'),
    ]);
    assert.strictEqual(tokenizedText, 'IBAN [internationalbankingaccountnumber_1], bel [phonenumber_1].');
    assert.deepStrictEqual(Object.keys(tokenMap).sort(), ['[internationalbankingaccountnumber_1]', '[phonenumber_1]']);
});
