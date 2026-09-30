/**
 * The Library hub, rendered against canned answers: each collection's newest
 * rows, a templates router the plan switched off said as such rather than as
 * an error, and the search collapsing the hub into one list of matches.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { LibraryScreen } from './LibraryScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { organizationId: null } }) }));
// The markdown renderer ships as ESM; nothing on the hub renders markdown.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const ANSWERS: Record<string, unknown> = {
    '/api/notebooks': {
        notebooks: [{ id: 'nb1', name: 'Supplier review', sourceCount: 2, processingCount: 1 }],
        hasMore: false,
    },
    '/api/kb': [{ id: 'kb1', name: 'Policies', description: 'HR handbook', document_count: '3' }],
    '/api/kb/kb1/documents': { documents: [{ id: 'd1', title: 'Leave policy', chunk_count: 4 }], total: 1 },
};

beforeEach(() => {
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (path === '/api/templates') return Promise.reject(new ApiError('Forbidden', { status: 403 }));
        return Promise.resolve(ANSWERS[path] ?? null);
    });
});

/** The hub's sheets toast, so the screen needs the toast host the root layout mounts. */
const renderLibrary = () =>
    renderWithProviders(
        <ToastProvider>
            <LibraryScreen />
        </ToastProvider>,
    );

describe('LibraryScreen', () => {
    it('draws the newest rows of every collection', async () => {
        await renderLibrary();
        expect(await screen.findByText('Supplier review')).toBeTruthy();
        expect(await screen.findByText('HR handbook')).toBeTruthy();
        expect(await screen.findByText('Leave policy')).toBeTruthy();
        expect(screen.getByText('Memory')).toBeTruthy();
        expect(screen.getByText('House styles')).toBeTruthy();
    });

    it('explains a templates router the plan switched off instead of failing', async () => {
        await renderLibrary();
        expect(await screen.findByText('Templates are not enabled')).toBeTruthy();
    });

    it('collapses into one list of matches while searching', async () => {
        await renderLibrary();
        await screen.findByText('HR handbook');
        fireEvent.changeText(screen.getByPlaceholderText('Search your library'), 'leave');
        expect(await screen.findByText('Leave policy')).toBeTruthy();
        expect(screen.getByText('Document')).toBeTruthy();
        expect(screen.queryByText('ALSO HERE')).toBeNull();
    });
});
