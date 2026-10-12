import { describe, it, expect } from 'vitest';
import previewBinding from './bindingPreview';

const sample = {
    steps: { s1: { output: { result: { tags: ['red', 'green', 'blue'], rows: [{ a: 1 }], text: 'Hello', gone: null } } } },
};
const tpl = (value) => previewBinding({ kind: 'template', value }, sample, { raw: false });

describe('previewBinding: template', () => {
    it('a list of plain values reads like the delivered text', () => {
        expect(tpl('{{steps.s1.output.result.tags}}')).toBe('red, green, blue');
    });

    it('a list of records reads one "key: value" row per record, as the run writes it', () => {
        // It used to preview "[1 item]" while interpolateTemplate wrote the row
        // into the text (templateText) — the example line must say what runs.
        expect(tpl('{{steps.s1.output.result.text}} {{steps.s1.output.result.rows}}')).toBe('Hello a: 1');
    });
});

describe('previewBinding: ref', () => {
    it('a whole-field binding shows the values of a list of plain values (the "list of 3" badge says it is a list)', () => {
        expect(previewBinding({ kind: 'ref', path: 'steps.s1.output.result.tags' }, sample, { raw: false })).toBe('red, green, blue');
        // A table still reads as its count: rows are not one line of text.
        expect(previewBinding({ kind: 'ref', path: 'steps.s1.output.result.rows' }, sample, { raw: false })).toBe('[1 item]');
    });
});
