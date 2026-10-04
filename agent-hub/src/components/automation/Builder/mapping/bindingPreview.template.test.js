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

    it('a list of records stays a count, a value is shown as is', () => {
        expect(tpl('{{steps.s1.output.result.text}} {{steps.s1.output.result.rows}}')).toBe('Hello [1 item]');
    });
});

describe('previewBinding: ref', () => {
    it('a whole-field binding still shows the list as a count (it keeps the typed list)', () => {
        expect(previewBinding({ kind: 'ref', path: 'steps.s1.output.result.tags' }, sample, { raw: false })).toBe('[3 items]');
    });
});
