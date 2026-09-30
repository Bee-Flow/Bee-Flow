/**
 * One knowledge base against canned answers: the Studio header and its five
 * sections, a source opened and put on a schedule, a source's documents, a surface switched off in
 * Settings, documents deleted in bulk, and the used-by list.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { KnowledgeBaseScreen } from './KnowledgeBaseScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ useHasPermission: () => true }));
// The scanner sheet is mounted (closed); its native camera module has no JS fallback.
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [null, jest.fn()] }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1', organizationId: 'o1' } }) }));

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';

const ANSWERS: Record<string, unknown> = {
    '/api/kb/kb1': { id: 'kb1', name: 'Price list', organization_id: 'o1', is_published: true, shared_groups: '[]', usage_contexts: ['agent', 'ai_step'], documents: [] },
    '/api/kb/kb1/documents': { documents: [{ id: DOC_A, title: 'Prices 2026', chunk_count: 4 }, { id: DOC_B, title: 'Terms', chunk_count: 2 }], total: 2 },
    '/api/kb/kb1/sources': {
        sources: [{ id: 's1', kind: 'webpage', name: 'Our site', config: { url: 'https://x', crawl: { maxPages: 5 } }, documentCount: 3, refreshMode: 'manual', supportsModes: ['manual', 'schedule'] }],
        totals: { sourceCount: 1 },
    },
    '/api/kb/kb1/sources/s1/documents': {
        documents: [
            { id: 'd1', title: 'home.html', status: 'processed', created_at: '2026-09-01T00:00:00Z' },
            { id: 'd2', title: 'broken.html', status: 'error', status_reason: 'Page returned 404', pii_status: 'unscanned' },
        ],
        total: 2,
        limit: 50,
        offset: 0,
    },
    '/api/kb/kb1/usage': { usage: [{ kind: 'agent', id: 'a1', title: 'Sales bot', role: 'chat' }], unchecked: [] },
    '/api/kb/favorites': [],
    '/api/kb/categories': [{ id: 'c1', name: 'Sales' }],
};

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.patch as jest.Mock).mockResolvedValue({ success: true });
    (api.post as jest.Mock).mockResolvedValue({ deleted: 2 });
});

const render = () => renderWithProviders(<ToastProvider><ConfirmProvider><KnowledgeBaseScreen kbId="kb1" /></ConfirmProvider></ToastProvider>);

describe('KnowledgeBaseScreen', () => {
    it('opens on its sources, and puts one on a schedule', async () => {
        await render();
        expect(await screen.findByText('Price list')).toBeTruthy();
        for (const tab of ['Sources, 1', 'Documents, 2', 'Test question', 'Settings', 'Used by, 1']) {
            expect(await screen.findByLabelText(tab)).toBeTruthy();
        }
        await fireEvent.press(await screen.findByText('Our site'));
        await fireEvent.press(await screen.findByLabelText('Every Monday at 06:00'));
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/kb/kb1/sources/s1', { refresh: expect.objectContaining({ mode: 'schedule', cron: '0 6 * * 1' }) }));
    });

    it('opens a source on its documents, each with its status', async () => {
        await render();
        await fireEvent.press(await screen.findByText('Our site'));
        await fireEvent.press(await screen.findByTestId('source-documents-open'));
        expect(await screen.findByText('home.html')).toBeTruthy();
        expect(screen.getByText('processed')).toBeTruthy();
        expect(screen.getByText('failed')).toBeTruthy();
        expect(screen.getByText('Page returned 404')).toBeTruthy();
        await fireEvent.press(screen.getByLabelText(/^Skipped/));
        await waitFor(() =>
            expect(api.get).toHaveBeenCalledWith('/api/kb/kb1/sources/s1/documents', expect.objectContaining({ query: { status: 'skipped,error', limit: 50, offset: 0 } })),
        );
    });

    it('switches a surface off in Settings', async () => {
        await render();
        await fireEvent.press(await screen.findByLabelText('Settings'));
        await fireEvent(await screen.findByLabelText('Agents'), 'valueChange', false);
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/kb/kb1', { usageContexts: ['ai_step'] }));
        expect(screen.getByText('Entire organisation')).toBeTruthy();
    });

    it('deletes selected documents in one request', async () => {
        await render();
        await fireEvent.press(await screen.findByLabelText('Documents, 2'));
        await fireEvent.press(await screen.findByText('Select'));
        await fireEvent.press(await screen.findByText('Prices 2026'));
        await fireEvent.press(screen.getByText('Terms'));
        await fireEvent.press(screen.getByTestId('kb-bulk-delete'));
        await screen.findByText('Delete 2 documents?');
        await fireEvent.press(screen.getAllByText('Delete').at(-1)!);
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/kb/kb1/documents/bulk-delete', { documentIds: [DOC_A, DOC_B] }, { retry: false }),
        );
    });

    it('lists what uses the base', async () => {
        await render();
        await fireEvent.press(await screen.findByLabelText('Used by, 1'));
        expect(await screen.findByText('Sales bot')).toBeTruthy();
    });
});
