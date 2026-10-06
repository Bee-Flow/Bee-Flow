/**
 * How a value reads inside a `{{ }}` placeholder — the runtime's templateText
 * — reaches the flow editor through the facade, so a preview never imports
 * the vendored files directly and always says what the run will write.
 */

import * as facade from './index';
import * as vendor from './vendor/index.mjs';

describe('templateText through the facade', () => {
    it('is the vendored runtime function itself', () => {
        expect(facade.templateText).toBe(vendor.templateText);
        expect(facade.isScalarList).toBe(vendor.isScalarList);
    });

    it('joins a list of plain values, or writes it as JSON when asked', () => {
        expect(facade.templateText(['a', 'b'])).toBe('a, b');
        expect(facade.templateText(['a', 'b'], { lists: 'json' })).toBe('["a","b"]');
        expect(facade.isScalarList([1, 'x', null])).toBe(true);
        expect(facade.isScalarList([{ a: 1 }])).toBe(false);
    });
});
