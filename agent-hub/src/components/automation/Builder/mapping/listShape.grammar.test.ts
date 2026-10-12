// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { forEachPickFor, pathListShape, previewForEachPick, splitColumnPath } from './listShape';

/**
 * A list path as discovery now writes it: quoted keys (`["line-items"]`), a
 * `[*]` or a `]` inside a quoted key, a name/value match segment. The split
 * and the "run once per row" pick must read the path as the runtime does,
 * not as text.
 */
const ROOT = {
    steps: {
        s: {
            output: {
                'line-items': [{ 'unit price': 3, 'a[*]b': 'x' }, { 'unit price': 4, 'a[*]b': 'y' }],
                headers: [{ name: 'Subject', value: 'Hi' }],
            },
        },
    },
};

describe('list paths with quoted keys', () => {
    it('splits on the first REAL [*], not on one inside a quoted key', () => {
        expect(splitColumnPath('steps.s.output["line-items"][*]["a[*]b"]'))
            .toEqual({ arrayPath: 'steps.s.output["line-items"]', tail: '["a[*]b"]' });
        expect(splitColumnPath('steps.s.output["x[*]y"]')).toEqual({ arrayPath: 'steps.s.output["x[*]y"]', tail: '' });
    });

    it('names the item after the list key, quoted or not', () => {
        const pick = forEachPickFor('steps.s.output["line-items"][*]["unit price"]', ROOT);
        expect(pick.forEach.overRef).toBe('steps.s.output["line-items"]');
        expect(pick.itemVar).toMatch(/^line_?item$/);
        expect(pick.binding).toEqual({ kind: 'ref', path: `loop.${pick.itemVar}["unit price"]` });
        expect(previewForEachPick('steps.s.output["line-items"][*]["unit price"]', ROOT)).toBe(3);
    });

    it('counts a column the way the runtime resolves it', () => {
        const shape = pathListShape('steps.s.output["line-items"][*]["a[*]b"]', ROOT);
        expect(shape?.count).toBe(2);
        expect(shape?.rows).toBe(2);
        expect(getPath(ROOT, 'steps.s.output.headers[name="Subject"].value')).toBe('Hi');
    });
});
