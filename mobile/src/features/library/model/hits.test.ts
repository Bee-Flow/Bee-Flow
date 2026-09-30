/**
 * The Library hub's search: notebooks arrive already server-filtered, the
 * other collections are filtered here, and every hit opens the right screen.
 */

import { buildHits, type HubCollections } from './hits';

const collections = (): HubCollections => ({
    notebooks: [
        {
            id: 'nb1', name: 'Supplier review', description: '', type: '', projectId: null,
            organizationId: null, version: 1, sourceCount: 2, processingCount: 0, failedCount: 0,
            sourceWordCount: 0, docWordCount: 0, messageCount: 0, preview: 'Q3 notes', pinned: false,
            pinnedAt: null, lastActivityAt: null, lastActivityKind: null, createdAt: null, updatedAt: null,
        },
    ],
    bases: [
        {
            id: 'kb1', tenant_id: 't', name: 'Policies', description: 'HR handbook', organization_id: null,
            category_id: null, icon: null, is_published: true, source_kind: null, system_slug: null,
            document_count: 3, created_at: '',
        },
        {
            id: 'kb2', tenant_id: 't', name: 'Invoices', description: null, organization_id: null,
            category_id: null, icon: null, is_published: true, source_kind: null, system_slug: null,
            created_at: '',
        },
    ],
    documents: [
        {
            id: 'd1', tenant_id: 't', knowledge_base_id: 'kb1', title: 'Leave policy', source_type: 'upload',
            source_uri: null, lang: null, content_hash: null, chunk_count: 4, created_at: '', kbId: 'kb1',
            kbName: 'Policies',
        },
    ],
    templates: [
        {
            id: 't1', userId: 'u', name: 'Offer letter', description: 'Policy-compliant offer', instructions: '',
            fileName: null, storageKey: '', parameters: [{ name: 'Name', description: '' }],
            knowledgeBaseIds: [], createdAt: null, updatedAt: null,
        },
    ],
});

describe('buildHits', () => {
    it('is empty while the search box is', () => {
        expect(buildHits('', collections())).toEqual([]);
    });

    it('keeps every notebook the server returned, and filters the rest by name and description', () => {
        const hits = buildHits('polic', collections());
        expect(hits.map((h) => `${h.kind}:${h.id}`)).toEqual([
            'notebook:nb1',
            'knowledge:kb1',
            'document:d1',
            'template:t1',
        ]);
    });

    it('points each kind at its own screen — a document at the base that holds it', () => {
        const byKind = Object.fromEntries(buildHits('p', collections()).map((h) => [h.kind, h]));
        expect(byKind.notebook?.href).toBe('/notebooks/nb1');
        expect(byKind.knowledge?.href).toBe('/knowledge/kb1');
        expect(byKind.document?.href).toBe('/knowledge/kb1');
        expect(byKind.template?.href).toBe('/templates');
        expect(byKind.knowledge?.meta).toBe('3 docs');
    });

    it('matches case-insensitively and leaves out what does not match', () => {
        expect(buildHits('INVOICE', collections()).map((h) => h.id)).toEqual(['nb1', 'kb2']);
    });
});
