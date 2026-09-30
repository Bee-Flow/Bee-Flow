/** Where a base can be used, what still uses it there, and the list's filter. */

import { attachedCount, matchesFilter, reindexOutcome, surfacesOf, toggleSurface } from './settings';

describe('surfaces', () => {
    it('reads an unsaid list as every surface, a said one as it is', () => {
        expect(surfacesOf({})).toEqual(['agent', 'direct_chat', 'ai_step']);
        expect(surfacesOf(null)).toEqual(['agent', 'direct_chat', 'ai_step']);
        expect(surfacesOf({ usage_contexts: ['agent'] })).toEqual(['agent']);
    });

    it('never leaves a base usable nowhere', () => {
        expect(toggleSurface(['agent', 'ai_step'], 'agent')).toEqual(['ai_step']);
        expect(toggleSurface(['agent'], 'direct_chat')).toEqual(['agent', 'direct_chat']);
        expect(toggleSurface(['agent'], 'agent')).toBeNull();
    });

    it('counts what still attaches through a surface', () => {
        const usage = [
            { kind: 'agent', role: 'chat' },
            { kind: 'webpage', role: 'chat' },
            { kind: 'automation', role: 'ai_step' },
            { kind: 'automation', role: 'read' },
        ];
        expect(attachedCount(usage, 'agent')).toBe(2);
        expect(attachedCount(usage, 'ai_step')).toBe(1);
        expect(attachedCount(usage, 'direct_chat')).toBe(0);
        expect(attachedCount(undefined, 'agent')).toBe(0);
    });
});

describe('matchesFilter', () => {
    const favorites = new Set(['a']);
    it('filters by favourite, by category and by having none', () => {
        expect(matchesFilter({ id: 'a', category_id: null }, 'favorites', favorites)).toBe(true);
        expect(matchesFilter({ id: 'b', category_id: null }, 'favorites', favorites)).toBe(false);
        expect(matchesFilter({ id: 'b', category_id: null }, 'uncategorised', favorites)).toBe(true);
        expect(matchesFilter({ id: 'b', category_id: 'c1' }, 'category:c1', favorites)).toBe(true);
        expect(matchesFilter({ id: 'b', category_id: 'c2' }, 'category:c1', favorites)).toBe(false);
        expect(matchesFilter({ id: 'b', category_id: 'c2' }, 'all', favorites)).toBe(true);
    });
});

describe('reindexOutcome', () => {
    const t = ((_key: string, fallback: string, vars?: Record<string, unknown>) =>
        fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''))) as Parameters<typeof reindexOutcome>[0];

    it('reports a complete pass as a success', () => {
        expect(reindexOutcome(t, { reindexed: 4, failed: 0, unattached: 0 }).tone).toBe('success');
    });

    it('does not call a pass with unattached documents done, and names them', () => {
        const out = reindexOutcome(t, { reindexed: 4, failed: 0, unattached: 2 });
        expect(out.tone).not.toBe('success');
        expect(out.text).toContain('2 documents belong to no source and were not re-embedded');
    });

    it('reports failures as an error', () => {
        expect(reindexOutcome(t, { reindexed: 1, failed: 1, unattached: 3 }).tone).toBe('error');
    });
});
