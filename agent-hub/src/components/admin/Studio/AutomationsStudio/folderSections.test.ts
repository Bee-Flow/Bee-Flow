// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { folderSectionsOf } from './folderSections';
import { NO_FOLDER } from './overviewModel';

const folders = [
    { id: 'fin', name: 'Finance' },
    { id: 'inv', name: 'Invoices', parentId: 'fin' },
    { id: 'hr', name: 'HR' },
    { id: 'empty', name: 'Archive' },
];
const row = (id: string, folderId: string | null = null) => ({ id, title: id, folderId });

describe('folderSectionsOf', () => {
    it('is null without folders: one plain grid, no headers', () => {
        expect(folderSectionsOf([row('a')], [])).toBeNull();
        expect(folderSectionsOf([row('a')], null)).toBeNull();
    });

    it('follows the tree order, names nested folders by path and puts loose rows last', () => {
        const s = folderSectionsOf([row('a', 'inv'), row('b'), row('c', 'hr'), row('d', 'fin')], folders);
        expect(s?.map(x => [x.id, x.path, x.depth, x.rows.map(r => r.id)])).toEqual([
            ['fin', 'Finance', 0, ['d']],
            ['inv', 'Finance / Invoices', 1, ['a']],
            ['hr', 'HR', 0, ['c']],
            [NO_FOLDER, '', 0, ['b']],
        ]);
    });

    it('skips folders with nothing in them and keeps the incoming order inside a section', () => {
        const s = folderSectionsOf([row('z', 'hr'), row('y', 'hr')], folders);
        expect(s?.map(x => x.id)).toEqual(['hr']);
        expect(s?.[0].rows.map(r => r.id)).toEqual(['z', 'y']);
    });

    it('counts a row in a folder the caller cannot see as loose', () => {
        const s = folderSectionsOf([row('a', 'gone')], folders);
        expect(s?.map(x => x.id)).toEqual([NO_FOLDER]);
    });
});
