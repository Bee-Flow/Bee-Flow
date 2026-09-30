/**
 * The cell formatter held to the web's: App Studio's rowValues.js over the
 * runtime's displayValue (AppStudio/runtime/uiBits.jsx), which the web's row
 * browser uses for every cell. Differential: both run on the same values.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC, loadWebFunctions, loadWebModule, webFileExists } from '@/shared/testing/webModule';

import { boolValue, cellText, dateInputValue, displayValue, listValue, optionPairs } from './cellValues';
import type { Column } from './types';

const ROW_VALUES = 'components/admin/Studio/AppStudio/tables/rowValues.js';
const UI_BITS = 'components/admin/Studio/AppStudio/runtime/uiBits.jsx';
const describeIfWeb = webFileExists(ROW_VALUES) && webFileExists(UI_BITS) ? describe : describe.skip;

type Web = {
    cellText: (v: unknown, f: unknown) => string;
    listValue: (v: unknown) => unknown[];
    boolValue: (v: unknown) => boolean;
    optionPairs: (f: unknown) => unknown[];
    dateInputValue: (v: unknown, t: string) => string;
};

/** A top-level `const NAME = <literal>;` of the web file, evaluated. */
function webConstant(name: string): unknown {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/${UI_BITS}`, 'utf8');
    const literal = new RegExp(`^(?:export )?const ${name} = (.+);$`, 'm').exec(src)?.[1];
    return new Function(`return ${literal};`)();
}

/** uiBits.jsx holds JSX, so only its two pure functions are taken, with their two constants. */
function loadWeb(): { rows: Web; displayValue: (v: unknown) => string } {
    const bits = loadWebFunctions<{ displayValue: (v: unknown) => string }>(UI_BITS, ['summarize', 'displayValue'], {
        EM_DASH: webConstant('EM_DASH'),
        OBJECT_LABEL_KEYS: webConstant('OBJECT_LABEL_KEYS'),
    });
    return { rows: loadWebModule<Web>(ROW_VALUES, { displayValue: bits.displayValue }), displayValue: bits.displayValue };
}

const VALUES: unknown[] = [
    null, undefined, '', 0, 1, 1234.5, NaN, true, false, 'yes', 'TRUE', '0', 'x',
    '["a","b"]', '[broken', ['a', { value: 'b', label: 'Bee' }], [], [{ nested: 1 }], ['only'],
    { name: 'Named' }, { title: 7 }, {}, { a: 1, b: 2 }, '2026-03-14', '2026-03-14T09:30:00.000Z', '2026-03-14 09:30',
];

const FIELDS = [
    { type: 'text' }, { type: 'richtext' }, { type: 'number' }, { type: 'bool' }, { type: 'date' }, { type: 'datetime' },
    { type: 'select', options: ['a', 'x'] }, { type: 'multiselect', options: ['a', 'b'] }, { type: 'file' }, null,
] as (Pick<Column, 'type' | 'options'> | null)[];

describeIfWeb('cellValues matches the web row browser', () => {
    it('formats every value for every column type the same way', () => {
        const web = loadWeb();
        for (const value of VALUES) {
            expect({ value, text: displayValue(value) }).toEqual({ value, text: web.displayValue(value) });
            expect({ value, list: listValue(value), yes: boolValue(value) }).toEqual({ value, list: web.rows.listValue(value), yes: web.rows.boolValue(value) });
            for (const field of FIELDS) {
                expect({ value, field, text: cellText(value, field) }).toEqual({ value, field, text: web.rows.cellText(value, field) });
            }
            for (const type of ['date', 'datetime']) {
                expect({ value, type, v: dateInputValue(value, type) }).toEqual({ value, type, v: web.rows.dateInputValue(value, type) });
            }
        }
    });

    it('reads options the same way', () => {
        const web = loadWeb();
        const fields = [{ options: ['a', '', 'b'] }, { options: [{ value: 'v', label: 'L' }, { label: 'only' }, 3] }, {}, null];
        for (const f of fields) expect(optionPairs(f as Pick<Column, 'options'>)).toEqual(web.rows.optionPairs(f));
    });
});

describe('cellValues on the phone', () => {
    it('says yes and no in the words it is given', () => {
        const words = { yes: 'Ja', no: 'Nee' };
        expect(cellText(1, { type: 'bool', options: [] }, words)).toBe('Ja');
        expect(displayValue(false, words)).toBe('Nee');
    });
});
