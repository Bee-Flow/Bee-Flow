/**
 * The spreadsheet reader held to App Studio's spreadsheetPaste.js, which the
 * web's datatable import shares. Differential: the web module (over the web's
 * own rowValues and displayValue) runs on the same text. The one intended
 * difference — a cell error is a code here, a sentence there — is compared as
 * "failed or not".
 */

import { loadWebModule, webFileExists } from '@/shared/testing/webModule';

import { buildImportRows, coerceCell, parseDateish, parseNumberish, parsePasted, suggestMapping } from './csvImport';
import type { Column } from './types';

const PASTE = 'components/admin/Studio/AppStudio/tables/spreadsheetPaste.js';
const ROW_VALUES = 'components/admin/Studio/AppStudio/tables/rowValues.js';
const describeIfWeb = webFileExists(PASTE) && webFileExists(ROW_VALUES) ? describe : describe.skip;

type Web = {
    parsePasted: (text: string) => { header: string[]; rows: string[][]; delimiter: string };
    suggestMapping: (header: string[], fields: unknown[]) => string[];
    parseNumberish: (text: string) => number;
    parseDateish: (text: string) => string | null;
    coerceCell: (raw: unknown, field: unknown) => { value: unknown; error: string | null };
    buildImportRows: (parsed: unknown, mapping: string[], fields: unknown[]) => { line: number; values: unknown; problems: unknown[] }[];
};

function loadWeb(): Web {
    // The reader takes only optionPairs from rowValues, which never calls displayValue.
    const rowValues = loadWebModule<{ optionPairs: unknown }>(ROW_VALUES, { displayValue: String });
    return loadWebModule<Web>(PASTE, { optionPairs: rowValues.optionPairs });
}

const TEXTS = [
    '',
    'Name\tEmail\nAnna\tanna@example.com\n\n',
    'Name;Amount;Starts on\n"de Vries; A.";1.234,56;14-03-2026\nBob;"12";2026-3-1\r\n',
    'a,b\n"multi\nline",x\n"say ""hi""",y\n',
    'only header',
    ' Spaced , Header \n1,2',
];

const FIELDS: Column[] = [
    { id: 'f1', key: 'name', name: 'Name', type: 'text', options: [], required: true, unique: false },
    { id: 'f2', key: 'amount', name: 'Amount', type: 'number', options: [], required: false, unique: false },
    { id: 'f3', key: 'starts_on', name: 'Starts on', type: 'date', options: [], required: false, unique: false },
    { id: 'f4', key: 'active', name: 'Active', type: 'bool', options: [], required: false, unique: false },
    { id: 'f5', key: 'stage', name: 'Stage', type: 'select', options: ['New', 'Won'], required: false, unique: false },
    { id: 'f6', key: 'tags', name: 'Tags', type: 'multiselect', options: ['a', 'b'], required: false, unique: false },
    { id: 'f7', key: 'at', name: 'At', type: 'datetime', options: [], required: false, unique: false },
];

const CELLS = ['', '  ', '12', '1.234,56', '1,234.56', '1,5', '1,234', '€ 3', 'abc', 'ja', 'Nee', 'maybe', 'x',
    '2026-02-30', '31/12/2026', '03/04/2026', '13/13/2026', '2026-03-14 9:05', '14-03-2026T25:00', 'new', 'WON', 'a; B', 'a|c'];

describeIfWeb('csvImport matches the web spreadsheet reader', () => {
    it('splits files the same way', () => {
        const web = loadWeb();
        for (const text of TEXTS) expect({ text, parsed: parsePasted(text) }).toEqual({ text, parsed: web.parsePasted(text) });
    });

    it('matches headers to columns the same way', () => {
        const web = loadWeb();
        const headers = [['name', 'AMOUNT', 'starts-on', 'nope', 'Name'], [], ['', 'Tags']];
        for (const h of headers) expect(suggestMapping(h, FIELDS)).toEqual(web.suggestMapping(h, FIELDS));
    });

    it('reads numbers, dates and cells the same way', () => {
        const web = loadWeb();
        for (const cell of CELLS) {
            expect({ cell, n: parseNumberish(cell) }).toEqual({ cell, n: web.parseNumberish(cell) });
            expect({ cell, d: parseDateish(cell) }).toEqual({ cell, d: web.parseDateish(cell) });
            for (const field of FIELDS) {
                const ours = coerceCell(cell, field);
                const theirs = web.coerceCell(cell, field);
                expect({ cell, type: field.type, value: ours.value, failed: ours.error !== null }).toEqual({
                    cell, type: field.type, value: theirs.value, failed: theirs.error !== null,
                });
            }
        }
    });

    it('builds the same rows, lines and values', () => {
        const web = loadWeb();
        const parsed = parsePasted('Name;Amount;Stage\nAnna;12;New\n;x;Lost\nBob;;Won\n');
        const mapping = suggestMapping(parsed.header, FIELDS);
        const ours = buildImportRows(parsed, mapping, FIELDS).map((r) => ({ line: r.line, values: r.values, problems: r.problems.length }));
        const theirs = web.buildImportRows(parsed, mapping, FIELDS).map((r) => ({ line: r.line, values: r.values, problems: r.problems.length }));
        expect(ours).toEqual(theirs);
    });
});

describe('csvImport on the phone', () => {
    it('does not read the byte-order mark of an exported CSV as part of the first header', () => {
        expect(parsePasted('﻿"id",name\n1,a').header).toEqual(['id', 'name']);
    });

    it('answers a code and the offending text instead of a sentence', () => {
        expect(coerceCell('abc', FIELDS[1]!)).toEqual({ value: null, error: { code: 'number', text: 'abc' } });
        expect(coerceCell('', FIELDS[0]!)).toEqual({ value: null, error: { code: 'required', text: '' } });
        expect(coerceCell('a; zz', FIELDS[5]!).error).toEqual({ code: 'choice', text: 'zz' });
        expect(coerceCell('', FIELDS[3]!)).toEqual({ value: false, error: null });
    });

    it('names an unnamed file column by its position', () => {
        const parsed = { header: ['', 'Amount'], rows: [['x', 'y']], delimiter: ',' };
        const [row] = buildImportRows(parsed, ['name', 'amount'], FIELDS);
        expect(row?.problems).toEqual([{ column: 'Amount', error: { code: 'number', text: 'y' } }]);
        expect(buildImportRows({ ...parsed, rows: [['', '1']] }, ['name', 'amount'], FIELDS)[0]?.problems[0]?.column).toBe('#1');
    });
});
