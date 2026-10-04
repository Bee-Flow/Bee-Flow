import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));

import { ADDABLE, SOURCE, itemsOf, rowsOf } from './addPartsSources';
import { SECTIONS } from './solutionSections';

const ctx = { projectId: 'sol1', alreadyIn: new Set<string>(), me: 'u1' };

describe('where each kind is listed', () => {
    it('an automation is listed by the Studio automations endpoint, not the legacy task table', () => {
        expect(SOURCE.automation).toBe('/api/automation');
    });

    it('skills and document templates have a source of their own', () => {
        expect(SOURCE.skill).toBe('/api/skills');
        expect(SOURCE.document_template).toBe('/api/studio-documents?kind=template&limit=200');
    });

    it('every movable kind of a Solution can be added', () => {
        expect(ADDABLE.map(s => s.kind)).toEqual(SECTIONS.filter(s => s.movable).map(s => s.kind));
        expect(ADDABLE.map(s => s.kind)).toEqual(expect.arrayContaining(['automation', 'skill', 'document_template']));
    });
});

describe('reading a listing', () => {
    it('reads the array whatever the endpoint calls it', () => {
        expect(rowsOf({ automations: [1] })).toEqual([1]);
        expect(rowsOf({ documents: [1, 2], total: 2 })).toEqual([1, 2]);
        expect(rowsOf([3])).toEqual([3]);
        expect(rowsOf({ error: 'nope' })).toBeNull();
        expect(rowsOf(null)).toBeNull();
    });

    it('a body that is not a listing is null, never an empty list', () => {
        expect(itemsOf('automation', { error: 'x' }, ctx)).toBeNull();
    });

    it('drops what is here already, what is not yours, and keeps what sits in another Solution', () => {
        const items = itemsOf('skill', { skills: [
            { id: 's1', name: 'Mine', userId: 'u1', projectId: null },
            { id: 's2', name: 'Here', userId: 'u1', projectId: 'sol1' },
            { id: 's3', name: 'Shared', userId: 'u2', projectId: null },
            { id: 's4', name: 'Elsewhere', userId: 'u1', projectId: 'sol9' },
            { id: 's5', name: 'Listed as in', userId: 'u1' },
        ] }, { ...ctx, alreadyIn: new Set(['skill:s5']) });
        expect(items).toEqual([
            { kind: 'skill', id: 's1', label: 'Mine', inProjectId: null },
            { kind: 'skill', id: 's4', label: 'Elsewhere', inProjectId: 'sol9' },
        ]);
    });

    it('a template says where it is filed with solutionProjectId', () => {
        const items = itemsOf('document_template', { documents: [
            { id: 'd1', name: 'Quote', userId: 'u1', solutionProjectId: 'sol9' },
            { id: 'd2', name: 'Letter', userId: 'u1', solutionProjectId: null },
        ] }, ctx);
        expect(items?.map(i => [i.id, i.inProjectId])).toEqual([['d1', 'sol9'], ['d2', null]]);
    });

    it('an automation is labelled by its title', () => {
        expect(itemsOf('automation', { automations: [{ id: 'a1', title: 'Nightly', userId: 'u1' }] }, ctx)?.[0].label).toBe('Nightly');
    });
});
