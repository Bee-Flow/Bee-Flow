import { describe, expect, it } from 'vitest';

import {
    columnCounts, groupsOf, halfOpen, hiddenInGroup, leftWithTools, selectionOf,
} from './categoryMatrixModel';

const KINDS = [
    { id: 'Person', group: 'Personal', label: 'Person names' },
    { id: 'DateOfBirth', group: 'Personal', label: 'Date of birth' },
    { id: 'Email', group: 'Contact', label: 'Email addresses' },
    { id: 'IBAN', group: 'Financial', label: 'IBAN numbers' },
];

describe('categoryMatrixModel', () => {
    it('groups kinds in catalogue order, each group once', () => {
        const groups = groupsOf(KINDS);
        expect(groups.map(g => g.name)).toEqual(['Personal', 'Contact', 'Financial']);
        expect(groups[0].items.map(k => k.id)).toEqual(['Person', 'DateOfBirth']);
    });

    it('counts each column against the rows on screen', () => {
        // A stored id that is no longer a row must not make a header read
        // "5 of 4".
        const sel = selectionOf(['Person', 'Email', 'Retired'], {
            external: { blockCategories: ['Person'] },
            internal: { blockCategories: [] },
        });
        expect(columnCounts(KINDS, sel)).toEqual({ detect: 2, external: 1, internal: 0 });
    });

    it('treats missing lists as empty', () => {
        const sel = selectionOf(undefined, undefined);
        expect(columnCounts(KINDS, sel)).toEqual({ detect: 0, external: 0, internal: 0 });
    });

    it('counts the hidden kinds per group', () => {
        const sel = selectionOf(['Person'], undefined);
        const [personal, contact] = groupsOf(KINDS);
        expect(hiddenInGroup(personal, sel)).toBe(1);
        expect(hiddenInGroup(contact, sel)).toBe(0);
    });

    it('names the kinds looked for but held back from no tool', () => {
        const sel = selectionOf(['Person', 'Email'], {
            external: { blockCategories: ['Person'] },
            internal: { blockCategories: [] },
        });
        expect(halfOpen(KINDS, sel).map(k => k.id)).toEqual(['Email']);
    });

    it('stays quiet while both tool lists are empty', () => {
        // Then every detected kind is "half open", which is noise, not a
        // finding; the outside-tools header says "anything may leave" instead.
        const sel = selectionOf(['Person', 'Email'], undefined);
        expect(halfOpen(KINDS, sel)).toEqual([]);
    });

    it('reports "left with tools" only for a known, positive count', () => {
        expect(leftWithTools({ Person: 33 }, 'Person')).toBe(33);
        expect(leftWithTools({ Person: 33 }, 'Email')).toBeNull();
        expect(leftWithTools({ Person: 0 }, 'Person')).toBeNull();
        // Unknown figures render nothing, never a zero.
        expect(leftWithTools(null, 'Person')).toBeNull();
    });
});
