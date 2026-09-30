/** The `labels_json` column, and toggling one label on a chat. */

import { parseLabels, toggleLabel } from './labels';

describe('parseLabels', () => {
    it('reads the ids and drops anything that is not one', () => {
        expect(parseLabels('["a", 2, "b"]')).toEqual(['a', 'b']);
    });

    it('costs a malformed blob its labels, not the row', () => {
        expect(parseLabels(null)).toEqual([]);
        expect(parseLabels('{oops')).toEqual([]);
        expect(parseLabels('{"a":1}')).toEqual([]);
    });
});

describe('toggleLabel', () => {
    it('adds a label that is off and removes one that is on', () => {
        expect(toggleLabel(['a'], 'b')).toEqual(['a', 'b']);
        expect(toggleLabel(['a', 'b'], 'a')).toEqual(['b']);
    });
});
