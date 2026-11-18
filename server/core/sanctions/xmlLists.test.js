// @typecheck
'use strict';
/**
 * The XML lists (EU FSF, UN SC, UK FCDO) read from small hand-written files in each official format.
 * Run: cd server && node --test core/sanctions/xmlLists.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseEuFsf, parseUnSc, parseUkFcdo } = require('./xmlLists.mts');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('EU FSF: names, birth date, citizenship, programme, reference and regulation link', () => {
    const [person, company] = parseEuFsf(fixture('eu_fsf.xml'));
    assert.deepStrictEqual(person, {
        entityId: '101', kind: 'person', names: ['Jöran Testmann', 'Joran Testman'], birthDates: ['1970-05-04'],
        countries: ['XX'], programmes: ['TST'], reference: 'EU.1.11', url: 'https://eur-lex.europa.eu/example-regulation',
    });
    assert.strictEqual(company.kind, 'entity');
    assert.deepStrictEqual(company.names, ['Example Trading Company Ltd']);
});

test('UN SC: individuals and entities, empty aliases left out, nationality as an ISO code', () => {
    const [person, entity] = parseUnSc(fixture('un_sc.xml'));
    assert.deepStrictEqual(person.names, ['ALDO EXAMPLO', 'ALDO EXAMPLE']);
    assert.deepStrictEqual(person.birthDates, ['1968']);
    assert.deepStrictEqual(person.countries, ['NL']);
    assert.strictEqual(person.reference, 'TSi.001');
    assert.strictEqual(entity.kind, 'entity');
    assert.deepStrictEqual(entity.names, ['SAMPLE RELIEF FOUNDATION', 'SRF']);
    assert.deepStrictEqual(entity.countries, ['BE']);
});

test('UK FCDO: name parts joined, non-Latin names kept, "dd/mm/YYYY" read as a year, ship kind', () => {
    const [person, ship] = parseUkFcdo(fixture('uk_fcdo.xml'));
    assert.deepStrictEqual(person.names, ['Petra PROBEERSMA', 'P. Probeersma', 'Петра Пробеерсма']);
    assert.deepStrictEqual(person.birthDates, ['1981', '1982-03-12']);
    assert.deepStrictEqual(person.countries, ['NL', 'DE']);
    assert.strictEqual(person.reference, 'TST0001');
    assert.strictEqual(ship.kind, 'vessel');
});

test('a document without the expected root throws, so the stored list is kept', () => {
    assert.throws(() => parseEuFsf('<html><body>Service unavailable</body></html>'), /no <export> root/);
    assert.throws(() => parseUnSc('<export/>'), /no <CONSOLIDATED_LIST> root/);
    assert.throws(() => parseUkFcdo(''), /no <Designations> root/);
});
