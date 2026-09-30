/**
 * What the Studio Documents endpoints send: the paths under
 * /api/studio-documents, the list's server-side filters, the revision every
 * write names, and the share of a rendering.
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import {
    createStudioDocument,
    deleteStudioDocument,
    duplicateStudioDocument,
    getStudioDocument,
    listStarters,
    listStudioDocuments,
    listVersions,
    restoreVersion,
    shareStudioDocument,
    updateStudioDocument,
    validateStudioDocument,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } };
});
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn(async () => 'file:///cache/x') }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;
const del = api.delete as jest.Mock;
const DOC = { document: { id: 'd 1', name: 'Invoice', docType: 'invoice', bodyHtml: '', settings: {}, contract: {} } };

beforeEach(() => {
    jest.clearAllMocks();
    get.mockResolvedValue({});
    post.mockResolvedValue(DOC);
    patch.mockResolvedValue(DOC);
    del.mockResolvedValue({ success: true });
});

describe('reads', () => {
    it('lists with the filters as the server names them, empty ones left out', async () => {
        get.mockResolvedValue({ documents: [{ id: 'a' }] });
        const rows = await listStudioDocuments({ kind: 'template', format: '', query: '  ' }, 30);
        expect(rows.map((r) => r.id)).toEqual(['a']);
        expect(get).toHaveBeenCalledWith('/api/studio-documents', {
            query: { kind: 'template', query: undefined, docType: undefined, sort: 'updated', limit: 30, offset: 30 },
            signal: undefined,
        });
        await listStudioDocuments({ kind: 'document', format: 'presentation', query: 'acme' }, 0);
        expect(get.mock.calls[1]?.[1].query).toMatchObject({ query: 'acme', docType: 'presentation', offset: 0 });
    });

    it('reads one document, its versions and the starters', async () => {
        get.mockResolvedValueOnce(DOC).mockResolvedValueOnce({ versions: [] }).mockResolvedValueOnce({ starters: [] });
        expect((await getStudioDocument('d 1'))?.id).toBe('d 1');
        await listVersions('d 1');
        await listStarters('nl');
        expect(get.mock.calls.map((c) => c[0])).toEqual([
            '/api/studio-documents/d%201',
            '/api/studio-documents/d%201/versions',
            '/api/studio-documents/starters',
        ]);
        expect(get.mock.calls[2]?.[1].query).toEqual({ locale: 'nl' });
    });
});

describe('writes', () => {
    it('creates from a starter, or a blank presentation', async () => {
        await createStudioDocument({ name: 'Invoice', kind: 'document', locale: 'en', starterId: 'invoice' });
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents', { name: 'Invoice', locale: 'en', kind: 'document', starterId: 'invoice' });
        await createStudioDocument({ name: 'Deck', kind: 'document', locale: 'en', blankDeck: true });
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents', {
            name: 'Deck',
            locale: 'en',
            kind: 'document',
            docType: 'presentation',
            bodyHtml: '',
            css: '',
        });
    });

    it('names the revision a change was based on', async () => {
        const doc = await updateStudioDocument('d1', { name: 'New' }, 'v7', { editable: false });
        expect(patch).toHaveBeenCalledWith('/api/studio-documents/d1', { name: 'New', expectedVersionId: 'v7' });
        expect(doc?.editable).toBe(false);
        await restoreVersion('d1', 'v 2', 'v7');
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/versions/v%202/restore', { expectedVersionId: 'v7' });
    });

    it('duplicates, archives and validates', async () => {
        await duplicateStudioDocument('d1', 'template');
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/duplicate', { kind: 'template' });
        await deleteStudioDocument('d1');
        expect(del).toHaveBeenCalledWith('/api/studio-documents/d1');
        post.mockResolvedValueOnce({ valid: true, issues: [], sections: [] });
        const verdict = await validateStudioDocument('d1', { total: 5 }, { remote: 'include' });
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/validate', { values: { total: 5 }, sectionOverrides: { remote: 'include' } });
        expect(verdict.valid).toBe(true);
    });
});

describe('shareStudioDocument', () => {
    it('fetches each rendering from its own route with a file name and type', async () => {
        await shareStudioDocument('d1', 'Invoice 42 / ACME', 'pdf');
        await shareStudioDocument('d1', 'Deck', 'pptx');
        await shareStudioDocument('d1', '', 'preview');
        expect((shareServerFile as jest.Mock).mock.calls).toEqual([
            ['/api/studio-documents/d1/pdf', 'Invoice-42-ACME.pdf', 'application/pdf'],
            ['/api/studio-documents/d1/pptx', 'Deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
            ['/api/studio-documents/d1/preview', 'document.html', 'text/html'],
        ]);
    });
});
