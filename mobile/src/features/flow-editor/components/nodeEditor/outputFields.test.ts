import { draftRecords, draftValue, rowDraft, safeJsonText } from '@/features/flow-editor/formState/outputDrafts';

import { blankField, blankRecord, kindPatch, parseOutputText, patchRow, rowValue, syncDraft, textPatch, yesNoPatch } from './outputFields';

describe('a typed value', () => {
    it('stays text in a text row, and becomes a number in a number row — a decimal comma too', () => {
        expect(rowValue('text', '0042')).toBe('0042');
        expect(rowValue('number', '12')).toBe(12);
        expect(rowValue('number', '1,5')).toBe(1.5);
        expect(rowValue('number', '-3')).toBe(-3);
        expect(rowValue('number', '')).toBeNull();
        // Halfway to a number, or not one at all: kept as typed, never rounded to 0.
        expect(rowValue('number', 'abc')).toBe('abc');
    });

    it('keeps the typing buffer beside the value, and turns multi-line on for good', () => {
        const row = rowDraft('n', 1);
        expect(textPatch(row, '1.')).toEqual({ text: '1.', value: 1, multiline: false });
        const text = rowDraft('body', 'Dear Ada,');
        expect(textPatch(text, 'Dear Ada,\n\nThanks')).toMatchObject({ multiline: true });
        expect(textPatch({ ...text, multiline: true }, 'one line')).toMatchObject({ multiline: true });
    });

    it('converts what is in a row when its kind changes', () => {
        expect(kindPatch(rowDraft('n', '12'), 'number')).toEqual({ kind: 'number', value: 12, text: '12' });
        expect(kindPatch(rowDraft('ok', 'yes'), 'yesno')).toEqual({ kind: 'yesno', value: true, text: 'true' });
        expect(kindPatch(rowDraft('n', 3), 'text')).toEqual({ kind: 'text', value: '3', text: '3' });
        expect(yesNoPatch(false)).toEqual({ value: false, text: 'false' });
    });
});

describe('the draft', () => {
    it('adds an unnamed field that joins the JSON only once it is named', () => {
        const [rec] = draftRecords('{"a":1}');
        const rows = [...rec!.rows, blankField()];
        expect(draftValue('fields', [{ ...rec!, rows }])).toEqual({ a: 1 });
        const named = patchRow(rows, rows[1]!.id, { key: 'b', value: 'x', text: 'x' });
        expect(draftValue('fields', [{ ...rec!, rows: named }])).toEqual({ a: 1, b: 'x' });
    });

    it('starts a new record with the first record’s field names, empty', () => {
        const recs = draftRecords('[{"name":"Ann","age":3}]');
        const next = blankRecord(recs);
        expect(draftValue('records', [...recs, next])).toEqual([{ name: 'Ann', age: 3 }, { name: '', age: '' }]);
        expect(blankRecord([]).rows).toEqual([]);
    });

    it('re-reads the text only when somebody else wrote it', () => {
        const seed = safeJsonText({ n: 1 });
        const sync = { seed, records: draftRecords(seed) };
        expect(syncDraft(sync, seed)).toBe(sync);
        const other = syncDraft(sync, '{"m":2}');
        expect(other.seed).toBe('{"m":2}');
        expect(draftValue('fields', other.records)).toEqual({ m: 2 });
    });

    it('reads text that is not JSON as nothing', () => {
        expect(parseOutputText('{oops')).toBeUndefined();
        expect(parseOutputText('[1]')).toEqual([1]);
    });
});
