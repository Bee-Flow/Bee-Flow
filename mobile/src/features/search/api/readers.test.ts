/**
 * The search readers pin what a slightly wrong payload becomes: defaults for
 * missing fields, and lists that are missing altogether.
 */

import { readConversationRows, readNotebooks } from './readers';

describe('search readers', () => {
    it('reads each list under its own key, and nothing for a payload that is not one', () => {
        expect(readNotebooks({ notebooks: [{ id: 'n1', name: 'Q3' }] })[0]).toMatchObject({ sourceCount: 0, preview: '' });
        expect(readConversationRows([{ id: 'c1', updated_at: 'x' }])[0]).toMatchObject({ kind: undefined, title: null });
        expect(readConversationRows([{ id: 7 }])[0]?.id).toBe('7');
        expect(readNotebooks(null)).toEqual([]);
        expect(readConversationRows({ error: 'nope' })).toEqual([]);
    });
});
