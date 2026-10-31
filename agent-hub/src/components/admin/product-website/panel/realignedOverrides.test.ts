// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { adoptRealignedOverrides } from './realignedOverrides';

const prev = {
    siteByLocale: { nl: { header: { ctas: [{ label: 'Neem contact op' }, { label: 'Open de app' }] } } },
    pagesByLocale: { pg_1: { nl: { blocks: { b1: { content: { items: [{ q: 'een' }, { q: 'twee' }] } } } } } },
};

describe('adoptRealignedOverrides', () => {
    it('replaces the site override with the re-aligned one', () => {
        const moved = { nl: { header: { ctas: [{ label: 'Open de app' }, { label: 'Neem contact op' }] } } };
        const next = adoptRealignedOverrides(prev, 'site', moved, () => false);
        expect(next.siteByLocale?.nl).toEqual(moved.nl);
        expect(next.pagesByLocale).toBe(prev.pagesByLocale);
    });

    it('replaces one page override and keeps the other pages', () => {
        const moved = { nl: { blocks: { b1: { content: { items: [{ q: 'twee' }, { q: 'een' }] } } } } };
        const next = adoptRealignedOverrides(prev, 'pg_1', moved, () => false);
        expect(next.pagesByLocale?.pg_1?.nl).toEqual(moved.nl);
    });

    it('leaves a locale alone while an edit for it is still queued, and ignores empty answers', () => {
        const moved = { nl: { blocks: {} } };
        expect(adoptRealignedOverrides(prev, 'pg_1', moved, (l) => l === 'nl')).toBe(prev);
        expect(adoptRealignedOverrides(prev, 'pg_1', {}, () => false)).toBe(prev);
        expect(adoptRealignedOverrides(prev, 'pg_1', undefined, () => false)).toBe(prev);
    });
});
