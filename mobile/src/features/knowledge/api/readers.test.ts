/**
 * The knowledge-base readers: what a payload the server got slightly wrong
 * turns into, so a screen renders it instead of crashing on it.
 */

import { readKbDocumentsPage, readKbSearchHits, readKnowledgeBase, readKnowledgeBaseDetail } from './readers';

describe('readKnowledgeBase', () => {
    it('keeps the row and reads a COUNT() string as a number', () => {
        const kb = readKnowledgeBase({ id: 'kb1', name: 'Policies', document_count: '3', is_published: true, extra: 1 });
        expect(kb.id).toBe('kb1');
        expect(kb.document_count).toBe(3);
        expect(kb.is_published).toBe(true);
        expect('extra' in kb).toBe(false);
    });

    it('degrades a missing name to empty rather than undefined', () => {
        expect(readKnowledgeBase({ id: 'kb1' }).name).toBe('');
    });
});

describe('readKnowledgeBaseDetail', () => {
    it('is null for a body that is not an object', () => {
        expect(readKnowledgeBaseDetail(null)).toBeNull();
    });

    it('reads the embedded documents, leaving an unsent status unsaid', () => {
        const detail = readKnowledgeBaseDetail({ id: 'kb1', documents: [{ id: 'd1', chunk_count: '2' }] });
        expect(detail?.documents[0]?.chunk_count).toBe(2);
        expect(detail?.documents[0]?.status).toBeUndefined();
    });
});

describe('readKbDocumentsPage', () => {
    it('counts what the page holds when the server sends no total', () => {
        expect(readKbDocumentsPage({ documents: [{ id: 'a' }, { id: 'b' }] }).total).toBe(2);
        expect(readKbDocumentsPage({ documents: [], total: 40 }).total).toBe(40);
        expect(readKbDocumentsPage(null)).toEqual({ documents: [], total: 0, limit: 0, offset: 0 });
    });
});

describe('readKbSearchHits', () => {
    it('reads `chunks` from the local backend and `results` from the search-service', () => {
        expect(readKbSearchHits({ chunks: [{ id: 'c1', score: 0.03 }] }).map((h) => h.id)).toEqual(['c1']);
        expect(readKbSearchHits({ results: [{ id: 'r1', score: 1 }] }).map((h) => h.id)).toEqual(['r1']);
        // An empty `chunks` is an answer, not a reason to look elsewhere.
        expect(readKbSearchHits({ chunks: [], results: [{ id: 'r1' }] })).toEqual([]);
        expect(readKbSearchHits(null)).toEqual([]);
    });

    it('reads a document id as text, so global search can join the hit to its document', () => {
        const [hit] = readKbSearchHits({ chunks: [{ document_id: 7, chunk_id: 12, content: 'x' }] });
        expect(hit).toMatchObject({ document_id: '7', chunk_id: 12, content: 'x' });
    });
});
