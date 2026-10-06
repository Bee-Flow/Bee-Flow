// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { eachField, mergeElements, textHidesKey, valueChildren, type Field } from './fieldTree';
import { resolveElementSample, sampleToFields } from './sampleFields';

/**
 * A list of JSON-text rows (queue messages, Redis lists) whose records carry a
 * `length` key: at run time `rows[*].length` and `loop.item.length` read each
 * TEXT's length (path.mjs stepInto; a loop item is the raw text). The element
 * that stands for the list must not offer that key, or the item fields and
 * the Loop's `loop.item.*` promise a value the run never reads.
 */
const ROWS = ['{"length":5,"name":"a"}', '{"length":7,"name":"b","size":2}'];

const pathsOf = (fields: Field[]) => {
    const out: string[] = [];
    eachField(fields, f => out.push(f.path));
    return out;
};

describe('a `length` key inside JSON-text rows', () => {
    it('is one rule: hidden for text, kept for a record', () => {
        expect(textHidesKey(true, 'length')).toBe(true);
        expect(textHidesKey(false, 'length')).toBe(false);
        expect(textHidesKey(true, 'name')).toBe(false);
    });

    it('is left out of the merged element, also for a single row', () => {
        expect(mergeElements(ROWS)).toEqual({ name: 'a', size: 2 });
        expect(mergeElements([ROWS[0]])).toEqual({ name: 'a' });
        // A real record keeps it.
        expect(mergeElements([{ length: 5, name: 'a' }])).toEqual({ length: 5, name: 'a' });
    });

    it('is not offered as an item field, while the columns still resolve', () => {
        const root = { steps: { q: { output: { rows: ROWS } } } };
        const element = resolveElementSample('steps.q.output.rows', root);
        expect(element).toEqual({ name: 'a', size: 2 });
        expect(pathsOf(sampleToFields(element, 'loop.item'))).toEqual(['loop.item.name', 'loop.item.size']);
        const columns = pathsOf(valueChildren(ROWS, 'steps.q.output.rows'));
        expect(columns).not.toContain('steps.q.output.rows[*].length');
        expect(columns).toContain('steps.q.output.rows[*].name');
        expect(getPath(root, 'steps.q.output.rows[*].name')).toEqual(['a', 'b']);
    });
});
