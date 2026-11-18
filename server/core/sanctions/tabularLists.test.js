// @typecheck
'use strict';
/**
 * The tabular lists: OFAC SDN (two CSV files) and the Dutch national terrorism list (an
 * OpenDocument spreadsheet, built here from a small content.xml), plus the CSV reader.
 * Run: cd server && node --test core/sanctions/tabularLists.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { parseOfacSdn, ofacRemarks, parseNlTerrorism } = require('./tabularLists.mts');
const { parseCsv } = require('./csv.mts');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('CSV: quoted commas, doubled quotes, CRLF and a last line without a newline', () => {
    assert.deepStrictEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
    assert.deepStrictEqual(parseCsv('\n\nx\n'), [['x']]);
});

test('OFAC remarks: birth dates (alt. and ranges) and nationality / citizenship', () => {
    assert.deepStrictEqual(ofacRemarks('DOB 02 Feb 1975; alt. DOB 1976; POB Utrecht; nationality Netherlands; citizen Belgium.'),
        { birthDates: ['02 Feb 1975', '1976'], countries: ['Netherlands', 'Belgium.'] });
    assert.deepStrictEqual(ofacRemarks('DOB circa 1955 to 1958').birthDates, ['1955', '1958']);
});

test('OFAC SDN: aliases from ALT.CSV, "-0-" as empty, kinds, programmes, reference and detail link', () => {
    const [person, company] = parseOfacSdn(fixture('ofac_sdn.csv'), fixture('ofac_alt.csv'));
    assert.strictEqual(person.kind, 'person');
    assert.deepStrictEqual(person.names, ['DUMMYSON, Frederik', 'DUMMIJZOON, Frits']);
    assert.deepStrictEqual(person.birthDates, ['1975-02-02', '1976']);
    assert.deepStrictEqual(person.countries, ['NL', 'BE']);
    assert.deepStrictEqual(person.programmes, ['SDGT', 'TEST']);
    assert.strictEqual(person.reference, 'SDN 7001');
    assert.strictEqual(person.url, 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=7001');
    assert.strictEqual(company.kind, 'entity');
    assert.deepStrictEqual(company.countries, ['PA']);
    assert.throws(() => parseOfacSdn('not,a,list', ''), /12 SDN columns/);
});

const cell = (v) => (v === '' ? '<table:table-cell/>' : `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`);
const row = (cells) => `<table:table-row>${cells.map(cell).join('')}<table:table-cell table:number-columns-repeated="16377"/></table:table-row>`;

async function ods(rows) {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
        + `<office:body><office:spreadsheet><table:table table:name="Blad1">${rows.map(row).join('')}</table:table></office:spreadsheet></office:body></office:document-content>`;
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
    zip.file('content.xml', xml);
    return zip.generateAsync({ type: 'nodebuffer' });
}

test('NL terrorism list: rows after the "Achternaam" header, empty alias cells keep their column', async () => {
    const file = await ods([
        ['Personen en organisaties waarvan de tegoeden bevroren zijn'],
        ['Achternaam', 'Voornaam/namen', 'Alias', 'Geboortedatum (DD-MM-JJJJ)', 'Geboorteplaats', 'Datum ministeriële beslissing', 'Link officiële bekendmaking'],
        ['Voorbeeld', 'Karel Jan', '', '5-6-1990', 'Zwolle', '1-1-2020', 'Stcrt 12345'],
        ['Proefstichting', '', 'Stichting Proef', '', '', '2-2-2021', 'Stcrt 67890'],
    ]);
    const [person, org] = await parseNlTerrorism(file);
    assert.deepStrictEqual(person.names, ['Karel Jan Voorbeeld']);
    assert.deepStrictEqual(person.birthDates, ['1990-06-05']);
    assert.strictEqual(person.reference, 'Stcrt 12345');
    assert.strictEqual(person.kind, 'person');
    assert.strictEqual(person.entityId, 'voorbeeld-karel-jan-5-6-1990');
    assert.deepStrictEqual(org.names, ['Proefstichting', 'Stichting Proef']);
    assert.strictEqual(org.kind, 'entity');
});

test('NL terrorism list: a sheet without the header row throws', async () => {
    await assert.rejects(parseNlTerrorism(await ods([['Something else']])), /Achternaam/);
    await assert.rejects(parseNlTerrorism(Buffer.from('not a zip')), /./);
});
