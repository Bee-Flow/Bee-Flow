/**
 * The knowledge list against canned answers: filtered to favourites and by
 * category, a base starred from its menu, and the system bases one row away.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { KnowledgeListScreen } from './KnowledgeListScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const ANSWERS: Record<string, unknown> = {
    '/api/kb': [
        { id: 'a', name: 'Price list', category_id: 'c1', document_count: 2 },
        { id: 'b', name: 'Handbook', category_id: null, document_count: 1 },
    ],
    '/api/kb/favorites': ['b'],
    '/api/kb/categories': [{ id: 'c1', name: 'Sales' }],
    '/api/kb/system': { items: [{ id: 'sys', name: 'Dutch law', system_slug: 'nl_law', documentCount: 12, totalChunks: 400, enabledForOrg: true }] },
};

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.put as jest.Mock).mockResolvedValue({ success: true });
});

const render = () => renderWithProviders(<ToastProvider><ConfirmProvider><KnowledgeListScreen /></ConfirmProvider></ToastProvider>);

describe('KnowledgeListScreen', () => {
    it('filters to favourites and by category', async () => {
        await render();
        expect(await screen.findByText('Price list')).toBeTruthy();
        expect(screen.getByText('Handbook')).toBeTruthy();
        await fireEvent.press(screen.getByText('Favourites'));
        await waitFor(() => expect(screen.queryByText('Price list')).toBeNull());
        expect(screen.getByText('Handbook')).toBeTruthy();
        await fireEvent.press(await screen.findByText('Sales'));
        expect(await screen.findByText('Price list')).toBeTruthy();
        expect(screen.queryByText('Handbook')).toBeNull();
    });

    it('stars a base from its menu', async () => {
        await render();
        await fireEvent(await screen.findByText('Price list'), 'longPress');
        await fireEvent.press(await screen.findByText('Add to favourites'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/kb/a/favorite'));
    });

    it('shows the system bases and whether the organisation uses them', async () => {
        await render();
        await fireEvent.press(await screen.findByText('System knowledge bases'));
        expect(await screen.findByText('Dutch law')).toBeTruthy();
        expect(screen.getByText('On for your organisation')).toBeTruthy();
        expect(screen.getByText('12 documents · 400 passages')).toBeTruthy();
    });
});
