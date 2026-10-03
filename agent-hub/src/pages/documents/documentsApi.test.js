import { describe, it, expect, vi, beforeEach } from 'vitest';

// authFetch is the thing under test as much as the functions are: the PDF and
// preview endpoints need the session, and a bare fetch would arrive
// unauthenticated. Mocked so each test can assert what was actually called.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
// API_BASE is '' on purpose: that is what a PRODUCTION build uses (relative
// URLs behind the nginx proxy), and it is the case the `/api` prefix bug
// survived — a dev-shaped mock like 'http://host:3001' would have passed every
// assertion below while the shipped app called the wrong URL.
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const {
    listDocuments, getDocument, createDocument, updateDocument, deleteDocument,
    previewUrl, downloadPdf, listDocumentsPage, unarchiveDocument, postPresence,
} = await import('./documentsApi');

const ok = (body, headers = {}) => ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: (k) => headers[k] ?? null },
});

beforeEach(() => {
    fetchMock.mockReset();
});

describe('documentsApi — the endpoint it talks to', () => {
    it('targets /api/studio-documents, not /api/documents', async () => {
        // /api/documents is the legacy mobile "Generated PDFs" lister, whose
        // /list a /:id route here would swallow. Asserted because the two names
        // are one character apart and the failure would be a 404 nobody traces.
        fetchMock.mockResolvedValue(ok({ documents: [] }));
        await listDocuments();
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio-documents');
    });

    it('puts /api in the PATH, because API_BASE is empty in a production build', async () => {
        // The mock sets API_BASE to '/api'; production sets it to ''. Writing
        // `${API_BASE}/studio-documents` therefore worked in dev (API_BASE is
        // http://host:3001 there) and resolved to `/studio-documents` in
        // production — the SPA catch-all, which answers index.html with a 200.
        // Asserting the literal prefix is what keeps that from coming back.
        fetchMock.mockResolvedValue(ok({ documents: [] }));
        await listDocuments();
        expect(fetchMock.mock.calls[0][0].startsWith('/api/')).toBe(true);
    });

    it('encodes the id into every per-document path', async () => {
        fetchMock.mockResolvedValue(ok({ document: {} }));
        await getDocument('a/b');
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio-documents/a%2Fb');
    });

    it('previewUrl asks for the edit bridge only when told to', () => {
        expect(previewUrl('d1')).toBe('/api/studio-documents/d1/preview');
        expect(previewUrl('d1', { edit: true })).toBe('/api/studio-documents/d1/preview?edit=1');
    });
});

describe('documentsApi — writes', () => {
    it('PATCHes only the fields it was given', async () => {
        fetchMock.mockResolvedValue(ok({ document: {} }));
        await updateDocument('d1', { bodyHtml: '<p>x</p>' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/studio-documents/d1');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ bodyHtml: '<p>x</p>' });
    });

    it('creates and deletes against the right verbs', async () => {
        fetchMock.mockResolvedValue(ok({ document: { id: 'd1' } }));
        await createDocument({ name: 'Factuur', docType: 'invoice' });
        expect(fetchMock.mock.calls[0][1].method).toBe('POST');

        fetchMock.mockResolvedValue(ok({ success: true }));
        await deleteDocument('d1');
        expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    });

    it('returns [] rather than undefined when a list body is empty', async () => {
        fetchMock.mockResolvedValue(ok({}));
        expect(await listDocuments()).toEqual([]);
        fetchMock.mockResolvedValue(ok({}));
        expect(await listDocumentsPage()).toEqual({ documents: [], total: 0, people: {}, notebooks: false });
    });

    it('carries whether the library lists notebooks', async () => {
        fetchMock.mockResolvedValue(ok({ documents: [], total: 0, people: {}, notebooks: true }));
        expect((await listDocumentsPage()).notebooks).toBe(true);
    });

    it('asks for the archive, unarchives and beats presence on their own paths', async () => {
        fetchMock.mockResolvedValue(ok({ documents: [], total: 3, people: {} }));
        expect((await listDocumentsPage({ archived: '1', query: '', offset: 30 })).total).toBe(3);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio-documents?archived=1&offset=30');
        fetchMock.mockResolvedValue(ok({ document: { id: 'd1' } }));
        await unarchiveDocument('d1');
        expect(fetchMock.mock.calls[1][0]).toBe('/api/studio-documents/d1/unarchive');
        fetchMock.mockResolvedValue(ok({ peers: [] }));
        await postPresence('d1', { clientId: 'c1', state: 'viewing' });
        expect(fetchMock.mock.calls[2][0]).toBe('/api/studio-documents/d1/presence');
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ clientId: 'c1', state: 'viewing' });
    });
});

describe('documentsApi — errors carry the server\'s own words', () => {
    it('surfaces the server message, status and code', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 413,
            json: async () => ({ error: 'The document body is larger than the 512 KB limit.', code: 'document_too_large' }),
            headers: { get: () => null },
        });
        await expect(updateDocument('d1', { bodyHtml: 'x' })).rejects.toMatchObject({
            message: 'The document body is larger than the 512 KB limit.',
            status: 413,
            code: 'document_too_large',
        });
    });

    it('falls back to a readable message when the body is not JSON', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => { throw new Error('not json'); },
            headers: { get: () => null },
        });
        await expect(getDocument('d1')).rejects.toThrow('Failed to load document');
    });

    it('names the real problem when a 200 carries a body that is not JSON', async () => {
        // This is the SPA catch-all answering index.html because the URL was
        // wrong. Returning null and letting the caller die on `body.document`
        // produced "Cannot read properties of null (reading 'document')",
        // which points at the parser rather than at the URL.
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => { throw new Error('Unexpected token <'); },
            headers: { get: () => null },
        });
        await expect(getDocument('d1')).rejects.toMatchObject({ code: 'not_json' });
        await expect(getDocument('d1')).rejects.toThrow(/not JSON/);
    });
});

describe('downloadPdf', () => {
    let createdUrl;
    let revoked;
    let clicked;

    beforeEach(() => {
        createdUrl = 'blob:doc';
        revoked = [];
        clicked = [];
        global.URL.createObjectURL = vi.fn(() => createdUrl);
        global.URL.revokeObjectURL = vi.fn((u) => revoked.push(u));
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
            clicked.push({ href: this.href, download: this.download });
        });
    });

    it('fetches with auth rather than linking, and hands the blob to a synthetic anchor', async () => {
        // A bare <a href> would reach the endpoint without the session and get
        // a 401 page where the user expected a file.
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => null },
            blob: async () => new Blob(['%PDF'], { type: 'application/pdf' }),
        });
        const out = await downloadPdf('d1', 'Factuur 2026-014');
        expect(fetchMock).toHaveBeenCalledWith('/api/studio-documents/d1/pdf');
        expect(clicked).toHaveLength(1);
        expect(clicked[0].download).toBe('Factuur 2026-014.pdf');
        expect(out.degraded).toBe(false);
    });

    it('strips a filename down to something a filesystem accepts', async () => {
        fetchMock.mockResolvedValue({
            ok: true, status: 200, headers: { get: () => null },
            blob: async () => new Blob(['%PDF']),
        });
        await downloadPdf('d1', 'Fact/uur: "2026" *14*');
        expect(clicked[0].download).toBe('Factuur 2026 14.pdf');
    });

    it('never produces a nameless download', async () => {
        fetchMock.mockResolvedValue({
            ok: true, status: 200, headers: { get: () => null },
            blob: async () => new Blob(['%PDF']),
        });
        await downloadPdf('d1', '///');
        expect(clicked[0].download).toBe('document.pdf');
    });

    it('reports the pdfkit fallback so the editor can explain the plainer layout', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: (k) => (k === 'X-Document-Degraded' ? '1' : null) },
            blob: async () => new Blob(['%PDF']),
        });
        const out = await downloadPdf('d1', 'x');
        expect(out.degraded).toBe(true);
    });

    it('releases the object URL after the click', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue({
            ok: true, status: 200, headers: { get: () => null },
            blob: async () => new Blob(['%PDF']),
        });
        await downloadPdf('d1', 'x');
        expect(revoked).toEqual([]);           // not before the click has started
        vi.advanceTimersByTime(1000);
        expect(revoked).toEqual([createdUrl]);
        vi.useRealTimers();
    });

    it('throws with the server\'s reason when the render fails', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 400,
            headers: { get: () => null },
            json: async () => ({ error: 'This document is still empty.', code: 'document_empty' }),
        });
        await expect(downloadPdf('d1', 'x')).rejects.toMatchObject({
            message: 'This document is still empty.',
            code: 'document_empty',
        });
        expect(clicked).toHaveLength(0);
    });
});
