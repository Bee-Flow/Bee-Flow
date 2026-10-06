// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveElementSample } from './sampleFields';

/**
 * R10: the editor reads a step's source list the way the run does (getList),
 * so a list held as JSON text gives an element, and so its fields.
 */
describe('resolveElementSample — reads a list like the run', () => {
    it('reads a list held as JSON text', () => {
        const root = { steps: { sheet: { output: { rows: '[{"name":"Reiskosten Q3","amount":120},{"name":"Lunch","amount":18}]' } } } };
        expect(resolveElementSample('steps.sheet.output.rows', root)).toMatchObject({ name: expect.any(String), amount: expect.any(Number) });
    });

    it('still reads a plain array', () => {
        const root = { steps: { sheet: { output: { rows: [{ name: 'Contoso' }] } } } };
        expect(resolveElementSample('steps.sheet.output.rows', root)).toEqual({ name: 'Contoso' });
    });

    it('is null for text that is not a list, and for an empty list', () => {
        expect(resolveElementSample('steps.a.output.v', { steps: { a: { output: { v: 'not json' } } } })).toBeNull();
        expect(resolveElementSample('steps.a.output.v', { steps: { a: { output: { v: '[]' } } } })).toBeNull();
    });
});
