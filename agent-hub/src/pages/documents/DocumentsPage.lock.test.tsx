import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Documents library and a locked `studio_documents` (the enterprise
 * split, 2026-10). Without the capability the library stays a library: the
 * documents somebody made are listed, open and archive as before, and only
 * what MAKES or CHANGES one (new, duplicate, a folder, the bulk edits) is
 * left out, with one line that says why.
 */

const { api } = vi.hoisted(() => ({
    api: {
        listDocuments: vi.fn(),
        createDocument: vi.fn(),
        deleteDocument: vi.fn(),
        updateDocument: vi.fn(),
        documentRequest: vi.fn(),
    },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (k: string, fb?: string) => fb || k, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('./DocumentEditor', () => ({ default: ({ documentId }: { documentId: string }) => <div data-testid="editor">{documentId}</div> }));
vi.mock('./HouseStylePanel', () => ({ default: () => <div data-testid="house-style" /> }));
const entitlements: { loading: boolean; error: unknown; lockReason: (id: string) => string | null } = {
    loading: false, error: null, lockReason: () => null,
};
vi.mock('../../components/licensing/EntitlementsContext', () => ({
    useEntitlements: () => entitlements,
}));

import DocumentsPage from './DocumentsPage';

// The list loads behind a 180 ms debounce; under a full parallel run that
// plus the render can pass the default one second.
const SLOW = { timeout: 5000 };

const DOC = { id: 'd1', name: 'Factuur 2026-014', docType: 'invoice', updatedAt: '2026-09-20T10:00:00Z', visibility: 'private', categories: [] };

beforeEach(() => {
    api.listDocuments.mockReset().mockResolvedValue([DOC]);
    api.documentRequest.mockReset().mockResolvedValue({ folders: [] });
    api.deleteDocument.mockReset().mockResolvedValue(true);
    entitlements.loading = false;
    entitlements.error = null;
    entitlements.lockReason = () => null;
});

describe('DocumentsPage with Studio Documents locked', () => {
    it('lists, opens and archives what exists, and offers nothing that makes or changes a document', async () => {
        entitlements.lockReason = (id) => (id === 'studio_documents' ? 'ceiling' : null);
        render(<DocumentsPage onDocumentChange={() => {}} />);
        expect(await screen.findByText('Factuur 2026-014', {}, SLOW)).toBeTruthy();
        expect(screen.getByTestId('documents-locked').textContent).toMatch(/higher plan/);
        expect(screen.queryByText('New document')).toBeNull();
        expect(screen.queryByLabelText('Duplicate / use template')).toBeNull();
        expect(screen.queryByLabelText('New folder name')).toBeNull();
        expect(screen.queryByLabelText('Select Factuur 2026-014')).toBeNull();

        await userEvent.click(screen.getByLabelText('Archive document'));
        await userEvent.click(screen.getByText('Archive'));
        expect(api.deleteDocument).toHaveBeenCalledWith('d1');

        // The list reloads after the archive; the document is opened from it.
        await userEvent.click(await screen.findByText('Factuur 2026-014', {}, SLOW));
        expect((await screen.findByTestId('editor', {}, SLOW)).textContent).toBe('d1');
    });

    it('offers all of it when Studio Documents is included', async () => {
        render(<DocumentsPage onDocumentChange={() => {}} />);
        expect(await screen.findByText('Factuur 2026-014', {}, SLOW)).toBeTruthy();
        expect(screen.getByText('New document')).toBeTruthy();
        expect(screen.getByLabelText('Duplicate / use template')).toBeTruthy();
        expect(screen.queryByTestId('documents-locked')).toBeNull();
    });

    it('while the entitlements load nothing is locked, and the server\'s licence refusal is worded', async () => {
        entitlements.loading = true;
        entitlements.lockReason = () => 'ceiling';
        api.documentRequest.mockImplementation(async (path: string) => {
            if (path === '/folders') return { folders: [] };
            throw Object.assign(new Error('Making and changing documents is not included for you.'),
                { status: 403, code: 'feature_locked', feature: 'studio_documents' });
        });
        render(<DocumentsPage onDocumentChange={() => {}} />);
        await userEvent.click(await screen.findByLabelText('Duplicate / use template', {}, SLOW));
        expect(screen.queryByTestId('documents-locked')).toBeNull();
        expect((await screen.findByRole('alert', {}, SLOW)).textContent).toMatch(/available on a higher plan/);
    });
});
