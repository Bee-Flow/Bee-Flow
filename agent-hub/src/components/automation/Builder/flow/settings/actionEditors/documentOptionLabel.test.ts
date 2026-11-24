import { describe, expect, it } from 'vitest';
import { duplicateNameSuffix } from './documentOptionLabel';

describe('duplicateNameSuffix', () => {
    const docs = [
        { id: 'a', name: 'Quote', updatedAt: '2026-11-23T12:22:00.000Z' },
        { id: 'b', name: 'Quote', updatedAt: '2026-11-20T12:05:00.000Z' },
        { id: 'c', name: 'Invoice', updatedAt: '2026-11-23T12:22:00.000Z' },
    ];

    it('adds nothing to a unique name', () => {
        expect(duplicateNameSuffix(docs[2], docs, 'en')).toBe('');
    });

    it('tells two documents with one name apart by when they last changed', () => {
        const a = duplicateNameSuffix(docs[0], docs, 'en');
        const b = duplicateNameSuffix(docs[1], docs, 'en');
        expect(a).toMatch(/^ · .*23/);
        expect(b).toMatch(/^ · .*20/);
        expect(a).not.toBe(b);
    });

    it('adds nothing when the date is unknown', () => {
        expect(duplicateNameSuffix({ id: 'x', name: 'Quote' }, docs, 'en')).toBe('');
    });
});
