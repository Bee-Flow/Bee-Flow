import { describe, expect, it } from 'vitest';
import { fieldValueLabel } from './VariableTree';
import { describeField as describeFieldJs } from './fieldKinds';

const describeField = describeFieldJs as (field: object, root: unknown) => { detail: string | null };

/**
 * The short value after a field's name, shared with the {} picker: a column
 * reads "a · b · c" (resolved by the runtime grammar, a quoted key included),
 * text reads “quoted”, a group reads nothing.
 */
const ROOT = { steps: { s: { output: { rows: [{ 'first name': 'Ada' }, { 'first name': 'Bob' }, { 'first name': 'Cy' }], note: 'hello', meta: { a: 1 }, body: '{"data":{"id":5},"next":null}', one: '{"only":1}', metas: ['{"tags":["a"]}', '```json\n{"v":1}\n```'], solo: { k: 1 } } } } };

describe('fieldValueLabel', () => {
    it('reads a column of a list by its values', () => {
        expect(fieldValueLabel({ key: 'first name', path: 'steps.s.output.rows[*]["first name"]', sample: 'Ada' }, ROOT, null)).toBe('Ada · Bob · Cy');
    });

    it('quotes text and leaves a group to its children', () => {
        expect(fieldValueLabel({ key: 'note', path: 'steps.s.output.note', sample: 'x' }, ROOT, null)).toBe('“hello”');
        expect(fieldValueLabel({ key: 'meta', path: 'steps.s.output.meta', sample: {} }, ROOT, null)).toBe('');
    });

    it('describes JSON text by what it holds, never as raw text', () => {
        const field = { key: 'body', path: 'steps.s.output.body', sample: '' };
        expect(fieldValueLabel(field, ROOT, null)).toBe('');
        expect(describeField(field, ROOT).detail).toBe('· JSON with 2 fields');
    });

    it('a list of JSON texts reads as JSON, never as raw text or fences', () => {
        const field = { key: 'metas', path: 'steps.s.output.metas', sample: [] };
        expect(fieldValueLabel(field, ROOT, null)).toBe('');
        expect(describeField(field, ROOT).detail).toBe('of 2 · JSON');
    });

    it('says one field, not "1 fields"', () => {
        expect(describeField({ key: 'one', path: 'steps.s.output.one', sample: '' }, ROOT).detail).toBe('· JSON with 1 field');
        expect(describeField({ key: 'solo', path: 'steps.s.output.solo', sample: {} }, ROOT).detail).toBe('· 1 field');
    });
});
