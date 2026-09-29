import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The editor and a locked `studio_documents` (the enterprise split, 2026-10).
 * Without the capability the server answers `editable: false`, so the editor
 * is read-only, says why in one line, and keeps the downloads: a document
 * somebody made keeps working. Restoring a revision is a change, so it is not
 * offered on a document that cannot be edited.
 */

const { api } = vi.hoisted(() => ({
    api: {
        getDocument: vi.fn(),
        updateDocument: vi.fn(),
        downloadPdf: vi.fn(),
        downloadPptx: vi.fn(),
        listVersions: vi.fn(),
        restoreVersion: vi.fn(),
        previewDeckDraft: vi.fn(),
        createDocument: vi.fn(),
        previewUrl: vi.fn(() => '/preview'),
    },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (k: string, fb?: string) => fb || k, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('./DocumentCanvas', () => ({ default: () => <div data-testid="fake-canvas" /> }));
const entitlements: { loading: boolean; error: unknown; lockReason: (id: string) => string | null } = {
    loading: false, error: null, lockReason: () => null,
};
vi.mock('../../components/licensing/EntitlementsContext', () => ({
    useEntitlements: () => entitlements,
}));

import DocumentEditor from './DocumentEditor';

const DOC = { id: 'd1', name: 'Factuur 2026-014', docType: 'invoice', bodyHtml: '<p>a</p>', css: '', settings: {}, versionId: 'v2' };

beforeEach(() => {
    api.getDocument.mockReset();
    api.downloadPdf.mockReset().mockResolvedValue({ degraded: false });
    api.listVersions.mockReset().mockResolvedValue([{ id: 'v1', summary: 'First draft', createdAt: '2026-09-20T10:00:00Z' }]);
    api.updateDocument.mockReset();
    entitlements.lockReason = () => null;
});

describe('DocumentEditor with Studio Documents locked', () => {
    it('opens read-only, says why, and still downloads', async () => {
        entitlements.lockReason = (id) => (id === 'studio_documents' ? 'ceiling' : null);
        api.getDocument.mockResolvedValue({ ...DOC, editable: false });
        render(<DocumentEditor documentId="d1" onBack={() => {}} onRenamed={() => {}} onOpenInStudio={undefined} />);
        await screen.findByTestId('fake-canvas');
        expect(screen.getByTestId('documents-locked').textContent).toMatch(/open, download and archive/);
        expect((screen.getByTestId('document-edit-toggle') as HTMLButtonElement).disabled).toBe(true);

        await userEvent.click(screen.getByTestId('document-download-pdf'));
        await waitFor(() => expect(api.downloadPdf).toHaveBeenCalled());
        expect(api.updateDocument).not.toHaveBeenCalled();
    });

    it('lists the history of a read-only document but offers no restore', async () => {
        entitlements.lockReason = () => 'ceiling';
        api.getDocument.mockResolvedValue({ ...DOC, editable: false });
        render(<DocumentEditor documentId="d1" onBack={() => {}} onRenamed={() => {}} onOpenInStudio={undefined} />);
        await screen.findByTestId('fake-canvas');
        await userEvent.click(screen.getByText('History'));
        expect(await screen.findByText('First draft')).toBeTruthy();
        expect(screen.queryByLabelText('Restore this version')).toBeNull();
    });

    it('with Studio Documents there is no lock line, and restore is offered', async () => {
        api.getDocument.mockResolvedValue({ ...DOC, editable: true });
        render(<DocumentEditor documentId="d1" onBack={() => {}} onRenamed={() => {}} onOpenInStudio={undefined} />);
        await screen.findByTestId('fake-canvas');
        expect(screen.queryByTestId('documents-locked')).toBeNull();
        await userEvent.click(screen.getByText('History'));
        expect(await screen.findByLabelText('Restore this version')).toBeTruthy();
    });
});
