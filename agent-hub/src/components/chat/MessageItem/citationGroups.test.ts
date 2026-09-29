// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { documentCountOf, documentKeyOf, groupByDocument } from './citationGroups';

/**
 * BFSF-352: `kbSources` holds one entry per passage. The chip row, the
 * sources panel and the count pill group them by DOCUMENT through this one
 * helper, so a handful of meeting notes no longer read as ten identical chips.
 */

describe('documentKeyOf', () => {
    it('a live table row is its own source, whatever its title', () => {
        expect(documentKeyOf({ title: 'Widget A', datatableId: 't-1', rowId: 'r-7', documentId: 'd-1' })).toBe('row:t-1:r-7');
    });

    it('the documents row wins over the title, in either spelling', () => {
        expect(documentKeyOf({ title: 'Notes', documentId: 'd-1' })).toBe('doc:d-1');
        expect(documentKeyOf({ title: 'Other title', document_id: 'd-1' })).toBe('doc:d-1');
    });

    it('without an id, two meetings that share a title stay two', () => {
        const a = documentKeyOf({ title: 'Weekly sync', occurredAt: '2026-08-01T09:00:00Z' });
        const b = documentKeyOf({ title: 'Weekly sync', occurredAt: '2026-08-08T09:00:00Z' });
        expect(a).not.toBe(b);
        expect(documentKeyOf({ title: 'Weekly sync' })).toBe('title:Weekly sync');
    });

    it('a passage with nothing to go on lands in one unknown group', () => {
        expect(documentKeyOf({ content: 'x' })).toBe('unknown');
        expect(documentKeyOf(null)).toBe('unknown');
    });
});

describe('groupByDocument', () => {
    it('folds passages of one document, in the order documents first appear', () => {
        const groups = groupByDocument([
            { title: 'Notes A', documentId: 'd-1', content: 'one', score: 0.2 },
            { title: 'Notes B', documentId: 'd-2', content: 'two', score: 0.5 },
            { title: 'Notes A', documentId: 'd-1', content: 'three', score: 0.9 },
            null,
        ]);
        expect(groups.map(g => g.key)).toEqual(['doc:d-1', 'doc:d-2']);
        expect(groups[0].passages.map(p => p.content)).toEqual(['one', 'three']);
    });

    it('the chip opens the most relevant passage it can actually open', () => {
        const [group] = groupByDocument([
            // The agent project-KB path sends a snippet, not the passage.
            { title: 'Notes A', document_id: 'd-1', snippet: 'short', score: 0.99 },
            { title: 'Notes A', documentId: 'd-1', content: 'low', score: 0.1 },
            { title: 'Notes A', documentId: 'd-1', content: 'high', score: 0.4 },
        ]);
        expect(group.passages).toHaveLength(3);
        expect(group.best.content).toBe('high');
    });

    it('counts documents, not passages', () => {
        expect(documentCountOf([
            { title: 'Notes A', documentId: 'd-1' },
            { title: 'Notes A', documentId: 'd-1' },
            { title: 'Notes B', documentId: 'd-2' },
        ])).toBe(2);
        expect(documentCountOf([])).toBe(0);
    });
});
