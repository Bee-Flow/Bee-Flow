// @typecheck
'use strict';
/**
 * The PEP function check against the bundled Dutch and EU lists (pepFunctions.json).
 * Run: cd server && node --test core/sanctions/pepFunctions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { checkPepFunction, pepData } = require('./pepFunctions.mts');

const ids = (title) => checkPepFunction(title).matches.map((m) => m.id);

test('the data file: a version, both sources, unique ids, every entry with terms or groups', () => {
    const d = pepData();
    assert.match(d.version, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(d.sources.map((s) => s.list).sort(), ['eu', 'nl']);
    const seen = new Set();
    for (const f of d.functions) {
        assert.ok(!seen.has(f.id), `duplicate id ${f.id}`);
        seen.add(f.id);
        assert.ok((f.terms && f.terms.length) || (f.all && f.all.length), `${f.id} has nothing to match`);
    }
});

test('Dutch functions match in Dutch and English, with diacritics and case folded', () => {
    assert.ok(ids('Minister van Financiën').includes('nl.a.minister'));
    assert.ok(ids('Minister van Financiën').includes('eu.a.head_of_state_government_ministers'));
    assert.ok(ids('lid van de Tweede Kamer der Staten-Generaal').includes('nl.b.house'));
    assert.ok(ids('Raadsheer in de Hoge Raad').includes('nl.d.supreme_court'));
    assert.ok(ids('Directielid De Nederlandsche Bank').includes('nl.e.central_bank'));
    assert.ok(ids('Commandant Luchtstrijdkrachten').includes('nl.f.armed_forces'));
    assert.ok(checkPepFunction('Staatssecretaris van Justitie').isPep);
});

test('whole words only: a ministry employee or a general manager is no PEP', () => {
    assert.strictEqual(checkPepFunction('Beleidsmedewerker ministerie van Financiën').isPep, false);
    assert.strictEqual(checkPepFunction('General manager').isPep, false);
    assert.strictEqual(checkPepFunction('Burgemeester').isPep, false);
    assert.strictEqual(checkPepFunction('').matches.length, 0);
    assert.strictEqual(checkPepFunction(undefined).isPep, false);
});

test('functions that need two parts, and whose organisation keeps its own list, are possible', () => {
    const io = checkPepFunction('Deputy Director, European Patent Office');
    assert.ok(io.matches.some((m) => m.id === 'nl.h.international_organisation' && m.confidence === 'possible'));
    assert.strictEqual(io.isPep, false);
    assert.strictEqual(io.possiblePep, true);
    assert.strictEqual(checkPepFunction('Director').matches.length, 0, 'a role without the organisation is no match');
    assert.ok(ids('CEO of a state-owned company').includes('eu.g.state_owned_enterprise'));
});

test('EU institutions, and a former function still matches', () => {
    assert.ok(ids('Member of the European Parliament').includes('eu.union.parliament'));
    const former = checkPepFunction('Former ambassador to Belgium');
    assert.strictEqual(former.isPep, true);
    assert.strictEqual(former.former, true);
    assert.ok(checkPepFunction('oud-minister').former);
});
