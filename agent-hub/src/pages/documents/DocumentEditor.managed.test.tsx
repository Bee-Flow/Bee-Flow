import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * A template a Solution stage manages (design 9): the editor opens it
 * read-only, with the banner, and without the project that would join it to a
 * live co-editing room.
 */
const { api, seen } = vi.hoisted(() => ({
    api: { getDocumentView: vi.fn(), documentRequest: vi.fn(), fetchPreviewHtml: vi.fn(), listDocumentsPage: vi.fn() },
    seen: { page: null as null | Record<string, unknown>, designed: null as null | Record<string, unknown> },
}));
vi.mock('./documentsApi', () => api);
vi.mock('./PageEditor', () => ({ default: (p: { initial: Record<string, unknown> }) => { seen.page = p.initial; return <div data-testid="page-editor" />; } }));
vi.mock('./editor/DesignedEditor', () => ({ default: (p: { initial: Record<string, unknown> }) => { seen.designed = p.initial; return <div data-testid="designed-editor" />; } }));

const { default: DocumentEditor } = await import('./DocumentEditor');

const MANAGED = { solutionId: 's1', solutionName: 'Intake', stage: 'uat', releaseSeq: 2, devRef: { kind: 'document', id: 'dev-doc' } };
const DOC = { id: 'd1', userId: 'me', name: 'Offer', docType: 'report', bodyHtml: '<p>a</p>', versionId: 'v1', editable: true, deletable: true, projectId: 'p1' };

function open(doc: Record<string, unknown>) {
    api.getDocumentView.mockResolvedValue({ document: doc, people: {} });
    return render(withQueryClient(<DocumentEditor documentId="d1" currentUser={{ id: 'me' }} />));
}

beforeEach(() => { seen.page = null; seen.designed = null; api.getDocumentView.mockReset(); });

describe('DocumentEditor: a managed template', () => {
    it('shows the banner and hands the editor a document nobody may write', async () => {
        open({ ...DOC, managed: MANAGED });
        await screen.findByTestId('designed-editor');
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('Managed by Intake · UAT · Release 2.');
        expect(screen.getByRole('link', { name: 'Open in Dev' })).toHaveAttribute('href', '/app/studio/documents/dev-doc');
        expect(seen.designed).toMatchObject({ id: 'd1', editable: false, deletable: false });
    });

    it('does not file a managed page in its project, so no editing room is joined', async () => {
        open({ ...DOC, docType: 'page', managed: MANAGED });
        await screen.findByTestId('page-editor');
        expect(seen.page?.projectId).toBeNull();
        expect(seen.page?.editable).toBe(false);
    });

    it('leaves an ordinary document exactly as it was', async () => {
        open({ ...DOC, docType: 'page', managed: null });
        await screen.findByTestId('page-editor');
        expect(screen.queryByTestId('managed-part-banner')).toBeNull();
        expect(seen.page).toMatchObject({ projectId: 'p1', editable: true });
    });
});
