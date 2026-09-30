/**
 * The list: pages as rows, and a new page made from a description, which
 * opens on its Build tab with the description waiting as the first message.
 */

import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders, testQueryClient } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { WebpagesScreen } from './WebpagesScreen';
import { takeBrief } from '../model/pendingBrief';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue({
        webpages: [
            { id: 'wp1', name: 'Launch', tagline: 'Our new product', isPublished: true },
            { id: 'wp2', name: 'Menu', description: 'Lunch menu' },
        ],
    });
    (api.post as jest.Mock).mockResolvedValue({ success: true, webpage: { id: 'wp9', name: 'Bakery' } });
});

// A finished mutation schedules its own garbage collection; clearing the
// client after each test is what lets Jest exit.
let client: QueryClient | null = null;
afterEach(() => client?.clear());

async function renderList(startCreating = false) {
    client = testQueryClient();
    client.setDefaultOptions({ ...client.getDefaultOptions(), mutations: { retry: false, gcTime: Infinity } });
    await renderWithProviders(
        <ToastProvider>
            <WebpagesScreen startCreating={startCreating} />
        </ToastProvider>,
        { queryClient: client },
    );
}

describe('WebpagesScreen', () => {
    it('lists the pages with their state and opens one', async () => {
        await renderList();
        expect(await screen.findByText('Launch')).toBeTruthy();
        expect(screen.getByText('Our new product')).toBeTruthy();
        expect(screen.getByText('2 pages · 1 published')).toBeTruthy();
        expect(screen.getByText('Published')).toBeTruthy();
        expect(screen.getByText('Draft')).toBeTruthy();
        await fireEvent.press(screen.getByText('Menu'));
        expect(mockPush).toHaveBeenCalledWith('/webpages/wp2');
    });

    it('creates a page of the server’s default kind from a description and opens its preview, where the builder starts', async () => {
        await renderList(true);
        await fireEvent.changeText(screen.getByLabelText('What should it be?'), 'A bakery with a menu');
        await fireEvent.press(screen.getByText('Create'));
        await waitFor(() => expect(api.post).toHaveBeenCalled());
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/webpages/wp9'));
        expect(api.post).toHaveBeenCalledWith('/api/webpages', { prompt: 'A bakery with a menu' });
        expect(takeBrief('wp9')).toBe('A bakery with a menu');
    });
});
