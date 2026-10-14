import { describe, expect, it } from 'vitest';
import { sanitizeOperations, sanitizeParseJsonFields } from './dataNodeRows';

describe('the rows of the data nodes survive a save half-filled', () => {
    it('sanitizeParseJsonFields drops blank-name rows but KEEPS named rows with an empty path', () => {
        const rows = sanitizeParseJsonFields([
            { name: '  ', path: 'x' },            // blank name → dropped
            { name: 'pending', path: '' },        // half-edited → survives autosave
            { name: ' trimmed ', path: 'a.b', description: '  ', fallback: null },
            null,
            'garbage',
        ]);
        expect(rows).toEqual([
            { name: 'pending', path: '' },
            { name: 'trimmed', path: 'a.b', fallback: null }, // blank description stripped, fallback null kept
        ]);
    });

    it('sanitizeOperations keeps half-typed rows, drops junk, normalises shapes', () => {
        expect(sanitizeOperations([
            { op: 'groupId', target: '', keys: [' to ', ''] },      // incomplete → survives, keys trimmed
            { op: 'rowId', target: 'id', start: '' },               // '' start → omitted (not 0!)
            { op: 'rowId', target: 'id', start: 5 },
            { op: 'sort', key: 'a', direction: 'weird' },           // direction normalised to asc (omitted)
            { op: 'explode' },                                      // unknown op → dropped
            'junk', null,
        ])).toEqual([
            { op: 'groupId', target: '', keys: ['to'] },
            { op: 'rowId', target: 'id' },
            { op: 'rowId', target: 'id', start: 5 },
            { op: 'sort', key: 'a' },
        ]);
    });
});
