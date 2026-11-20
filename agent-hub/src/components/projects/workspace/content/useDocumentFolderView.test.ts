import { describe, expect, it } from 'vitest';
import { folderView } from './useDocumentFolderView';

const folders = [{ id: 'f1', name: 'Contracts', createdBy: 'a', createdAt: '' }, { id: 'f2', name: 'Empty', createdBy: 'a', createdAt: '' }];
const items = [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }];

describe('folderView', () => {
    it('shows everything when no folder is open, and counts each folder', () => {
        const view = folderView(items, { d1: 'f1', d2: 'f1', d3: 'gone' }, folders, null);
        expect(view.shown).toEqual(items);
        expect(view.counts).toEqual({ f1: 2 });
    });
    it('shows only the open folder\'s documents', () => {
        expect(folderView(items, { d1: 'f1' }, folders, 'f1').shown).toEqual([{ id: 'd1' }]);
        expect(folderView(items, { d1: 'f1' }, folders, 'f2').shown).toEqual([]);
    });
    it('falls back to everything when the open folder no longer exists', () => {
        const view = folderView(items, {}, folders, 'deleted');
        expect(view.current).toBeNull();
        expect(view.shown).toEqual(items);
    });
});
