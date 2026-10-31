// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildFolderTree, descendantIds, flattenFolderTree, folderPath, moveTargets } from './folderTree';

const folders = [
    { id: 'c', name: 'c-leaf', parentId: 'b' },
    { id: 'a', name: 'Finance', parentId: null },
    { id: 'b', name: 'Invoices', parentId: 'a' },
    { id: 'z', name: 'Clients' },
    { id: 'orphan', name: 'Orphan', parentId: 'missing' },
];

describe('folder tree', () => {
    it('nests by parentId, sorts siblings by name and records depth', () => {
        const flat = flattenFolderTree(buildFolderTree(folders));
        expect(flat.map((n) => [n.folder.id, n.depth])).toEqual([['z', 0], ['a', 0], ['b', 1], ['c', 2], ['orphan', 0]]);
    });

    it('shows a folder whose parent is unknown, or itself, at the top level', () => {
        const flat = flattenFolderTree(buildFolderTree([{ id: 'x', name: 'X', parentId: 'x' }]));
        expect(flat.map((n) => n.depth)).toEqual([0]);
    });

    it('survives a loop in bad data', () => {
        const flat = flattenFolderTree(buildFolderTree([{ id: 'p', parentId: 'q' }, { id: 'q', parentId: 'p' }]));
        expect(flat.length).toBeLessThanOrEqual(2);
    });

    it('lists the descendants of a folder, not the folder itself', () => {
        expect([...descendantIds(folders, 'a')].sort()).toEqual(['b', 'c']);
        expect(descendantIds(folders, 'c').size).toBe(0);
    });

    it('builds the path from the top level down', () => {
        expect(folderPath(folders, 'c')).toBe('Finance / Invoices / c-leaf');
    });

    it('offers as move targets neither the folder nor anything below it', () => {
        expect(moveTargets(folders, 'a').map((f) => f.id).sort()).toEqual(['orphan', 'z']);
    });
});
