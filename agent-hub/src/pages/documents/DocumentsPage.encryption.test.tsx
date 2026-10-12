import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * Starting a document while this session holds no encryption key is not a dead
 * end: the person unlocks (PIN for single sign-on, sign in again otherwise) and
 * the choice they made is carried out, without the refusal sitting on the dialog.
 */

const { api, client } = vi.hoisted(() => ({
    api: {
        listDocumentsPage: vi.fn(), documentRequest: vi.fn(), createDocument: vi.fn(), deleteDocument: vi.fn(),
        unarchiveDocument: vi.fn(), updateDocument: vi.fn(), createSpreadsheet: vi.fn(),
    },
    client: { get: vi.fn() },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiClient: client, default: client }));
vi.mock('./DocumentEditor', () => ({ default: ({ documentId }: { documentId: string }) => <div data-testid="editor-stub">editor {documentId}</div> }));
vi.mock('./HouseStylePanel', () => ({ default: () => <div /> }));
vi.mock('../EncryptionSetup', () => ({ default: ({ onComplete }: { onComplete: () => void }) => <button type="button" onClick={onComplete}>enter pin</button> }));

const { default: DocumentsPage } = await import('./DocumentsPage');

const starter = { id: 'security', name: 'Security policy / report', docType: 'security', kind: 'template', settings: { contract: { parameters: [{}, {}] } } };
const locked = () => Object.assign(new Error('The encryption key for this document is unavailable. Unlock encryption before continuing.'), { status: 423, code: 'document_encryption_key_unavailable' });

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.documentRequest.mockImplementation(async (path: string) => {
        if (path === '/folders') return { folders: [] };
        if (path.startsWith('/starters')) return { starters: [starter] };
        return {};
    });
    api.listDocumentsPage.mockResolvedValue({ documents: [], total: 0, people: {}, notebooks: false, spreadsheets: false });
});

const start = async () => {
    render(withQueryClient(<DocumentsPage />));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('documents-new'));
    await u.click(await screen.findByRole('button', { name: /Security policy/ }));
    return u;
};

describe('DocumentsPage: starting a document without an encryption key', () => {
    it('asks a single sign-on account for its PIN, then creates the template document', async () => {
        client.get.mockReset().mockResolvedValue({ user: { id: 'me', provider: 'microsoft' } });
        api.createDocument.mockRejectedValueOnce(locked()).mockResolvedValueOnce({ id: 'd-new' });
        const u = await start();
        await u.click(await screen.findByRole('button', { name: 'enter pin' }));
        await waitFor(() => expect(api.createDocument).toHaveBeenCalledTimes(2));
        expect(api.createDocument.mock.calls[1][0]).toMatchObject({ starterId: 'security' });
        expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor d-new');
    });

    it('tells a password account to sign in again and leaves no error on the dialog', async () => {
        client.get.mockReset().mockResolvedValue({ user: { id: 'me', provider: 'local' } });
        api.createDocument.mockRejectedValue(locked());
        await start();
        expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
        expect(screen.queryByText(/Unlock encryption before continuing/)).not.toBeInTheDocument();
    });
});
