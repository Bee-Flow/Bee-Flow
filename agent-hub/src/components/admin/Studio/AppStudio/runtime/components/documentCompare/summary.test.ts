import { describe, expect, it } from 'vitest';
import type { CompareResult, LookChange } from '@/api/queries/studioAppDocuments';
import { parseDocumentRef, sameDocument } from './docRef';
import { gridExtent } from './SheetGrid';
import { hasChanges, lookLabel, lookValue, summaryText } from './summary';
import { nextIndex } from './useStepper';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));

const deck = (summary: Partial<{ changed: number; added: number; removed: number; lookChanged: boolean }>, look: LookChange[] = []): CompareResult => ({
    family: 'deck', slides: [], look,
    summary: { changed: 0, added: 0, removed: 0, unchanged: 0, lookChanged: false, wordsAdded: 0, wordsRemoved: 0, ...summary },
});

describe('the change summary', () => {
    it('counts slides with the right singular and plural, and says when the look changed', () => {
        expect(summaryText(t, deck({ changed: 3, added: 1, lookChanged: true }))).toBe('3 slides changed, 1 slide added, look changed');
        expect(summaryText(t, deck({ removed: 2 }))).toBe('2 slides removed');
    });

    it('says "No differences" when nothing changed', () => {
        expect(summaryText(t, deck({}))).toBe('No differences');
        expect(hasChanges(deck({}))).toBe(false);
    });

    it('counts cells, rows and columns of a sheet, and paragraphs of a text', () => {
        const sheet: CompareResult = { family: 'sheet', tabs: [], summary: { tabsChanged: 1, tabsAdded: 0, tabsRemoved: 0, cellsChanged: 12, rowsAdded: 2, rowsRemoved: 0, columnsAdded: 0, columnsRemoved: 1 } };
        expect(summaryText(t, sheet)).toBe('12 cells changed, 2 rows added, 1 column removed');
        const text: CompareResult = { family: 'text', blocks: [{ op: 'modify' }], truncated: false, summary: { changed: 1, added: 0, removed: 4, unchanged: 3, wordsAdded: 2, wordsRemoved: 9 } };
        expect(summaryText(t, text)).toBe('1 paragraph changed, 4 paragraphs removed');
        expect(hasChanges(text)).toBe(true);
    });

    it('names a look change and its values in words', () => {
        expect(lookLabel(t, 'preset')).toBe('Design');
        expect(lookLabel(t, 'something_new')).toBe('something_new');
        const tpl: LookChange = { key: 'template', before: 'custom', after: 'custom', replaced: true };
        expect([lookValue(t, tpl, 'before'), lookValue(t, tpl, 'after')]).toEqual(['Its own', 'Another one']);
        expect(lookValue(t, { key: 'preset', before: '', after: 'minimal' }, 'before')).toBe('From the house style');
        expect(lookValue(t, { key: 'preset', before: '', after: 'minimal' }, 'after')).toBe('minimal');
    });
});

describe('document references', () => {
    it('reads an id, an id with a version, a step result and a list', () => {
        expect(parseDocumentRef('d1')).toEqual({ documentId: 'd1', versionId: null });
        expect(parseDocumentRef(' d1@v2 ')).toEqual({ documentId: 'd1', versionId: 'v2' });
        expect(parseDocumentRef({ kind: 'studio_document', documentId: 'c1', versionId: 'v9' })).toEqual({ documentId: 'c1', versionId: 'v9' });
        expect(parseDocumentRef([{ id: 'x' }, 'y'])).toEqual({ documentId: 'x', versionId: null });
    });

    it('refuses what is no reference', () => {
        for (const v of [null, '', 'a b', '../x', 'd1@', {}, 42, [], { documentId: '<script>' }]) expect(parseDocumentRef(v)).toBeNull();
    });

    it('tells the same document apart from two versions of it', () => {
        expect(sameDocument({ documentId: 'd', versionId: null }, { documentId: 'd', versionId: null })).toBe(true);
        expect(sameDocument({ documentId: 'd', versionId: 'v' }, { documentId: 'd', versionId: null })).toBe(false);
        expect(sameDocument({ documentId: 'd', versionId: null }, null)).toBe(false);
    });
});

describe('small helpers', () => {
    it('steps through changes and wraps at both ends', () => {
        expect([nextIndex(3, -1, 1), nextIndex(3, -1, -1), nextIndex(3, 2, 1), nextIndex(3, 0, -1), nextIndex(0, -1, 1)]).toEqual([0, 2, 0, 2, -1]);
    });

    it('measures the used part of a sheet', () => {
        expect(gridExtent({ A1: 'x', C4: '2', B2: '' })).toEqual({ cols: ['A', 'B', 'C'], rows: 4 });
        expect(gridExtent({})).toEqual({ cols: [], rows: 0 });
    });
});
