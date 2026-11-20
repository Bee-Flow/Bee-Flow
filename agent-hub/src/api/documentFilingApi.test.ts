import { describe, expect, it } from 'vitest';
import { filingTargetsOf, projectDocumentUrl } from './documentFilingApi';

describe('filingTargetsOf', () => {
    it('keeps only the projects the caller owns or edits', () => {
        expect(filingTargetsOf([
            { id: 'p1', name: 'Mine', permission: 'owner' },
            { id: 'p2', name: 'Team', permission: 'editor' },
            { id: 'p3', name: 'Read', permission: 'viewer' },
            { name: 'no id', permission: 'owner' },
        ])).toEqual([{ id: 'p1', name: 'Mine' }, { id: 'p2', name: 'Team' }]);
        expect(filingTargetsOf({ error: 'x' })).toEqual([]);
    });
    it('links to the document inside the project', () => {
        expect(projectDocumentUrl('p 1', 'd1')).toBe('/app/projects/p%201/documents/d1');
    });
});
