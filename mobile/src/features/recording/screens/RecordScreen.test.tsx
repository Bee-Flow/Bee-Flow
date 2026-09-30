/**
 * The Meeting Notes tab's library: the web's search, owner and tag filters over the
 * list, the tools menu that leads to the other Meeting Notes screens, and the
 * select-then-ask flow of the multi-meeting report.
 *
 * The recorder itself is stubbed: useRecorder has its own tests, and this
 * file is about what sits under the start button.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { RecordScreen } from './RecordScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/shared/markdown/Markdown', () => {
    const { Text } = jest.requireActual('react-native');
    return { Markdown: ({ value }: { value: string }) => <Text>{value}</Text> };
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('../hooks/useRecordTab', () => ({
    useRecordTab: () => ({
        recorder: {
            active: false,
            phase: 'idle',
            error: null,
            clearError: jest.fn(),
            permission: { unknown: false, granted: true },
            start: jest.fn(),
        },
        outbox: { items: [], upload: jest.fn(), cancel: jest.fn(), discard: jest.fn(), updateSettings: jest.fn() },
        onAccepted: jest.fn(),
        editing: null,
        setEditing: jest.fn(),
        draft: null,
        saving: false,
        requesting: false,
        importing: false,
        importAudio: jest.fn(),
        stop: jest.fn(),
        requestPermission: jest.fn(),
    }),
}));

const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    status: 'completed',
    isOwner: true,
    ownerId: 'me',
    createdAt: '2026-09-20T10:00:00Z',
    ...extra,
});

const LIST = {
    transcriptions: [
        row('a', 'Sales sync', { tags: ['sales'] }),
        row('b', 'Board meeting', { createdAt: '2026-09-21T10:00:00Z' }),
        row('c', 'Colleague call', { isOwner: false, ownerId: 'you', createdAt: '2026-09-19T10:00:00Z' }),
    ],
};


beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) =>
        Promise.resolve(path === '/api/transcriptions' ? LIST : [{ tag: 'sales', count: 1 }]),
    );
});

describe('RecordScreen', () => {
    it('filters by owner and by tag, and clears back to everything', async () => {
        await renderWithProviders(<RecordScreen />);
        expect(await screen.findByText('Board meeting')).toBeTruthy();
        await fireEvent.press(screen.getByText('Shared'));
        expect(screen.getByText('Colleague call')).toBeTruthy();
        expect(screen.queryByText('Board meeting')).toBeNull();
        await fireEvent.press(screen.getByText('All'));
        await fireEvent.press(await screen.findByLabelText('sales, 1'));
        expect(screen.getByText('Sales sync')).toBeTruthy();
        expect(screen.queryByText('Board meeting')).toBeNull();
    });

    it('says when nothing matches the search', async () => {
        await renderWithProviders(<RecordScreen />);
        await fireEvent.changeText(await screen.findByPlaceholderText('Search title, tag or text…'), 'zzz');
        expect(await screen.findByText('No meetings match your filters.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Clear filters'));
        expect(await screen.findByText('Board meeting')).toBeTruthy();
    });

    it('opens the other Meeting Notes screens from the tools menu', async () => {
        await renderWithProviders(<RecordScreen />);
        await screen.findByText('Board meeting');
        await fireEvent.press(screen.getByLabelText('Meeting notes tools'));
        await fireEvent.press(await screen.findByText('Upcoming meetings'));
        expect(mockPush).toHaveBeenCalledWith('/upcoming-meetings');
    });

    it('picks notes and asks one question over them', async () => {
        (api.post as jest.Mock).mockResolvedValue({ report: 'Both meetings agreed.', usedTranscripts: false, truncatedNotes: 0 });
        await renderWithProviders(<RecordScreen />);
        await screen.findByText('Board meeting');
        await fireEvent.press(screen.getByLabelText('Meeting notes tools'));
        await fireEvent.press(await screen.findByText('AI report'));
        await fireEvent.press(await screen.findByText('Board meeting'));
        await fireEvent.press(screen.getByText('Sales sync'));
        expect(mockPush).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByText('Ask AI'));
        await fireEvent.press(await screen.findByText('List everything that is still open or unresolved'));
        expect(await screen.findByText('Both meetings agreed.')).toBeTruthy();
        expect(screen.getByText(/Based on meeting summaries/)).toBeTruthy();
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith(
                '/api/transcriptions/report',
                { ids: ['a', 'b'], prompt: 'List everything that is still open or unresolved' },
                { retry: false, timeoutMs: 300_000 },
            ),
        );
    });
});
