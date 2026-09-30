/**
 * The Studio Documents library against canned answers: the rows the server
 * lists, the views and the format filter going to the server, the starter
 * gallery creating a document and opening it, and a row's archive asking
 * first.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { StudioDocumentsScreen } from './StudioDocumentsScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn() }));

const ROWS = [
    { id: 'd1', name: 'Invoice ACME', docType: 'invoice', kind: 'document', visibility: 'private', categories: ['sales'], updatedAt: '2026-09-20T10:00:00Z' },
    { id: 'd2', name: 'Quarterly review', docType: 'presentation', kind: 'document', visibility: 'private', categories: [], updatedAt: '2026-09-21T10:00:00Z' },
];
const STARTERS = [
    { id: 'invoice', name: 'Invoice', docType: 'invoice', settings: { contract: { parameters: [{}, {}, {}, {}, {}] } } },
    { id: 'deck-pitch', name: 'Pitch deck', docType: 'presentation', settings: { contract: { parameters: [{}, {}, {}, {}] } } },
];

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const del = api.delete as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    get.mockImplementation((path: string) => {
        if (path === '/api/studio-documents/starters') return Promise.resolve({ starters: STARTERS });
        if (path === '/api/studio-documents') return Promise.resolve({ documents: ROWS });
        return Promise.reject(new Error(`unexpected ${path}`));
    });
    post.mockResolvedValue({ document: { id: 'new-1', name: 'Invoice', docType: 'invoice', settings: {}, contract: {} } });
    del.mockResolvedValue({ success: true });
});

describe('StudioDocumentsScreen', () => {
    it('lists the documents with their type and visibility', async () => {
        await renderScreen(<StudioDocumentsScreen />);
        expect(await screen.findByText('Invoice ACME')).toBeTruthy();
        expect(screen.getByText('Invoice · Private · sales')).toBeTruthy();
        expect(screen.getByText('Presentation · Private')).toBeTruthy();
        fireEvent.press(screen.getByText('Invoice ACME'));
        expect(mockPush).toHaveBeenCalledWith('/documents/d1');
    });

    it('asks the server for the chosen view and format', async () => {
        await renderScreen(<StudioDocumentsScreen />);
        await screen.findByText('Invoice ACME');
        fireEvent.press(screen.getByText('Templates'));
        await waitFor(() => expect(get).toHaveBeenLastCalledWith('/api/studio-documents', expect.objectContaining({ query: expect.objectContaining({ kind: 'template' }) })));
        fireEvent.press(screen.getByText('Presentations'));
        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith('/api/studio-documents', expect.objectContaining({ query: expect.objectContaining({ docType: 'presentation' }) })),
        );
    });

    it('creates a document from a starter and opens it', async () => {
        await renderScreen(<StudioDocumentsScreen />);
        await screen.findByText('Invoice ACME');
        fireEvent.press(screen.getByLabelText('New document'));
        expect(await screen.findByText('5 parameters')).toBeTruthy();
        fireEvent.press(screen.getByText('Pitch deck'));
        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/studio-documents', { name: 'Pitch deck', locale: 'en', kind: 'document', starterId: 'deck-pitch' }));
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/documents/new-1'));
    });

    it('archives a row only after asking', async () => {
        await renderScreen(<StudioDocumentsScreen />);
        await screen.findByText('Invoice ACME');
        fireEvent.press(screen.getByLabelText('Actions for Invoice ACME'));
        fireEvent.press(await screen.findByText('Archive document'));
        expect(await screen.findByText('Archive “Invoice ACME”?')).toBeTruthy();
        expect(del).not.toHaveBeenCalled();
        fireEvent.press(screen.getByText('Archive'));
        await waitFor(() => expect(del).toHaveBeenCalledWith('/api/studio-documents/d1'));
    });
});
