import { describe, expect, it } from 'vitest';
import type { CommentAnchor } from '../../api/queries/comments';
import { anchorState, clampAnchor, CONTEXT_MAX, inReadingOrder, isUsableAnchor, QUOTE_MAX, quoteExcerpt } from './commentAnchors';

const anchor = (quote: string, extra: Partial<CommentAnchor> = {}): CommentAnchor => ({ quote, prefix: '', suffix: '', blockIndex: 0, ...extra });

describe('anchorState', () => {
    it('finds a quote through whitespace and, failing that, through case', () => {
        const text = 'We agreed the budget\n\nis 40k for Q3.';
        expect(anchorState({ anchor: anchor('the budget is 40k') }, text)).toBe('found');
        expect(anchorState({ anchor: anchor('THE BUDGET is 40K') }, text)).toBe('found');
    });

    it('reports a quote that is gone as outdated, and unknown without text', () => {
        expect(anchorState({ anchor: anchor('the budget is 50k') }, 'the budget is 40k')).toBe('outdated');
        expect(anchorState({ anchor: anchor('anything') }, null)).toBe('unknown');
    });

    it('names whole-item and unreadable threads as such', () => {
        expect(anchorState({ anchor: null }, 'text')).toBe('whole');
        expect(anchorState({ anchor: anchor('   ') }, 'text')).toBe('whole');
        expect(anchorState({ anchor: null, anchorUnreadable: true }, 'text')).toBe('unreadable');
    });
});

describe('clampAnchor', () => {
    it('keeps an anchor within the server bounds, the context nearest the quote', () => {
        const long = anchor('q'.repeat(QUOTE_MAX + 50), {
            prefix: `${'a'.repeat(CONTEXT_MAX)}END`, suffix: `START${'b'.repeat(CONTEXT_MAX)}`, blockIndex: -3,
        });
        const out = clampAnchor(long);
        expect(out.quote).toHaveLength(QUOTE_MAX);
        expect(out.prefix).toHaveLength(CONTEXT_MAX);
        expect(out.prefix.endsWith('END')).toBe(true);
        expect(out.suffix.startsWith('START')).toBe(true);
        expect(out.blockIndex).toBe(0);
    });

    it('keeps relative positions only as a pair, and the section id', () => {
        expect(clampAnchor(anchor('x', { relStart: 'AQID' }))).not.toHaveProperty('relStart');
        expect(clampAnchor(anchor('x', { relStart: 'AQID', relEnd: 'BAUG', sectionId: 'pricing' })))
            .toMatchObject({ relStart: 'AQID', relEnd: 'BAUG', sectionId: 'pricing' });
    });
});

describe('ordering and text', () => {
    it('puts whole-item threads first, then by block, then oldest first', () => {
        const threads = [
            { id: 'b3', anchor: anchor('x', { blockIndex: 3 }), createdAt: '2026-09-01T10:00:00Z' },
            { id: 'whole', anchor: null, createdAt: '2026-09-03T10:00:00Z' },
            { id: 'b1-late', anchor: anchor('x', { blockIndex: 1 }), createdAt: '2026-09-02T10:00:00Z' },
            { id: 'b1-early', anchor: anchor('x', { blockIndex: 1 }), createdAt: '2026-09-01T09:00:00Z' },
        ];
        expect(inReadingOrder(threads).map(t => t.id)).toEqual(['whole', 'b1-early', 'b1-late', 'b3']);
    });

    it('tells a usable selection and shortens a long quote', () => {
        expect(isUsableAnchor(anchor('words'))).toBe(true);
        expect(isUsableAnchor(anchor('  \n '))).toBe(false);
        expect(isUsableAnchor(null)).toBe(false);
        expect(quoteExcerpt('a  b\nc')).toBe('a b c');
        expect(quoteExcerpt('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
    });
});
