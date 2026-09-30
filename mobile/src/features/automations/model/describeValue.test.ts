/**
 * A step's output is DRAWN, not dumped — and the classifier that decides how
 * is conservative on purpose.
 *
 * `previewValue` pretty-prints every non-string output as JSON. That is honest
 * and unreadable: the commonest thing a routine step produces is a LIST OF
 * ROWS — search results, datatable rows, the files in a folder — and someone
 * reading a run on their phone got two braces and a wall of quoted keys where
 * the web builder shows a table. Web's OutputView has offered Fields / Table /
 * JSON for a while and defaults away from JSON; mobile never got the same
 * treatment, so one run read completely differently depending on the screen.
 *
 * What these tests mostly pin is the REFUSALS. A wrong table is worse than
 * honest JSON because it looks authoritative — so rows must be plain objects
 * sharing a key set with scalar cells, and anything less falls back rather
 * than inventing empty columns or printing "[object Object]" in a cell.
 *
 * Run: cd mobile && npx jest src/features/automations/model/describeValue.test.ts
 */

import {
    describeValue,
    MAX_PREVIEW_COLUMNS,
    MAX_PREVIEW_ROWS,
    type ValueShape,
} from './format';

describe('describeValue — nothing to show', () => {
    it.each([null, undefined, '', '   ', [], {}])('%p reads as empty', (v) => {
        expect(describeValue(v).kind).toBe('empty');
    });
});

describe('describeValue — a single value', () => {
    it('a string is itself', () => {
        expect(describeValue('Offerte verstuurd')).toEqual({ kind: 'scalar', text: 'Offerte verstuurd' });
    });

    it('a number is not mistaken for empty, including zero', () => {
        // `if (!value)` would swallow 0 and false. Both are answers.
        expect(describeValue(0)).toEqual({ kind: 'scalar', text: '0' });
        expect(describeValue(42)).toEqual({ kind: 'scalar', text: '42' });
    });

    it('a boolean reads as a word, not as true/false', () => {
        expect(describeValue(true)).toEqual({ kind: 'scalar', text: 'true' });
    });
});

describe('describeValue — a list of rows is a table', () => {
    const rows = [
        { name: 'Offerte.pdf', size: 12_400, shared: true },
        { name: 'Contract.docx', size: 8_100, shared: false },
    ];

    it('draws the columns in the order the first row declares them', () => {
        const shape = describeValue(rows) as Extract<ValueShape, { kind: 'rows' }>;
        expect(shape.kind).toBe('rows');
        expect(shape.columns).toEqual(['name', 'size', 'shared']);
        expect(shape.rows[0]).toEqual(['Offerte.pdf', '12400', 'Yes']);
        expect(shape.rows[1]).toEqual(['Contract.docx', '8100', 'No']);
    });

    it('reports the REAL total even when it only draws a page of them', () => {
        const many = Array.from({ length: MAX_PREVIEW_ROWS + 15 }, (_, i) => ({ n: i }));
        const shape = describeValue(many) as Extract<ValueShape, { kind: 'rows' }>;
        expect(shape.rows).toHaveLength(MAX_PREVIEW_ROWS);
        // The count is the honest part: a clipped table that claims to be the
        // whole answer is how someone concludes a routine dropped their rows.
        expect(shape.total).toBe(MAX_PREVIEW_ROWS + 15);
    });

    it('caps the columns rather than rendering unreadable slivers', () => {
        const wide = [Object.fromEntries(
            Array.from({ length: MAX_PREVIEW_COLUMNS + 4 }, (_, i) => [`c${i}`, i]),
        )];
        const shape = describeValue(wide) as Extract<ValueShape, { kind: 'rows' }>;
        expect(shape.columns).toHaveLength(MAX_PREVIEW_COLUMNS);
    });

    it('null is a WORD in a cell, not a blank', () => {
        // An absent value and an empty string are different facts about the
        // data, and a blank cell reads as the latter.
        const shape = describeValue([{ a: null }]) as Extract<ValueShape, { kind: 'rows' }>;
        expect(shape.rows[0]).toEqual(['—']);
    });
});

describe('describeValue — the refusals', () => {
    it('rows that disagree about their keys are NOT a table', () => {
        // Inventing an empty column here is how a user concludes a field came
        // back blank when it was never asked for.
        expect(describeValue([{ a: 1 }, { b: 2 }]).kind).toBe('raw');
    });

    it('a nested object in a cell is NOT a table', () => {
        expect(describeValue([{ a: 1, b: { deep: true } }]).kind).toBe('raw');
    });

    it('an array in a cell is NOT a table', () => {
        expect(describeValue([{ a: 1, b: [1, 2] }]).kind).toBe('raw');
    });

    it('a mixed array is neither a table nor a list', () => {
        expect(describeValue([{ a: 1 }, 'loose string']).kind).toBe('raw');
    });

    it('a record with one nested value falls back whole', () => {
        // Half a record drawn as fields and half as JSON is worse than either.
        expect(describeValue({ ok: 1, nested: { x: 1 } }).kind).toBe('raw');
    });

    it('the fallback still carries readable text, never an empty view', () => {
        const shape = describeValue([{ a: 1 }, { b: 2 }]) as Extract<ValueShape, { kind: 'raw' }>;
        expect(shape.text).toContain('"a"');
    });
});

describe('describeValue — a flat record is fields', () => {
    it('keeps every key, in order', () => {
        const shape = describeValue({ status: 'sent', attempts: 2, ok: true }) as Extract<ValueShape, { kind: 'record' }>;
        expect(shape.kind).toBe('record');
        expect(shape.fields).toEqual([
            { key: 'status', value: 'sent' },
            { key: 'attempts', value: '2' },
            { key: 'ok', value: 'Yes' },
        ]);
    });
});

describe('describeValue — a list of scalars', () => {
    it('is a list, with its true total', () => {
        const shape = describeValue(['a@b.nl', 'c@d.nl']) as Extract<ValueShape, { kind: 'list' }>;
        expect(shape.kind).toBe('list');
        expect(shape.items).toEqual(['a@b.nl', 'c@d.nl']);
        expect(shape.total).toBe(2);
    });
});

describe('describeValue — booleans in the reader’s language', () => {
    it('reads a boolean cell with the words it is given', () => {
        const words = { yes: 'Ja', no: 'Nee' };
        expect((describeValue({ ok: true }, words) as Extract<ValueShape, { kind: 'record' }>).fields[0]?.value).toBe('Ja');
        expect((describeValue([{ ok: false }], words) as Extract<ValueShape, { kind: 'rows' }>).rows[0]).toEqual(['Nee']);
        expect((describeValue([true, false], words) as Extract<ValueShape, { kind: 'list' }>).items).toEqual(['Ja', 'Nee']);
    });
});
