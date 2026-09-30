/**
 * The import screen: a Talk recording becomes a note that then opens, a Meet
 * recording without a file cannot be imported, and a failed import is shown.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { MeetingImportsScreen } from './MeetingImportsScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// The recording feature's index loads screens that nothing here renders.
jest.mock('@/features/recording', () => ({ useRefreshMeetings: () => jest.fn() }));

const ANSWERS: Record<string, unknown> = {
    '/api/transcriptions/nextcloud-talk-recordings': {
        rooms: [{ token: 'tok', name: 'Board', recordings: [{ name: 'call.ogg', path: '/Talk/tok/call.ogg', kind: 'audio' }] }],
    },
    '/api/transcriptions/gmeet-recordings': {
        connection: { googleConnected: true, meetScopesGranted: true },
        items: [{ eventId: 'e1', title: 'Sprint review', recordingState: 'none' }],
    },
    '/api/transcriptions/gmeet-imports': { items: [] },
    '/api/transcriptions/nextcloud-audio-files': { items: [] },
};

const renderScreen = () =>
    renderWithProviders(
        <ToastProvider>
            <MeetingImportsScreen />
        </ToastProvider>
    );

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

describe('MeetingImportsScreen', () => {
    it('transcribes a Talk recording and opens the note', async () => {
        (api.post as jest.Mock).mockResolvedValue({ id: 'n9', title: 'call' });
        await renderScreen();
        expect(await screen.findByText('call.ogg')).toBeTruthy();
        await fireEvent.press(screen.getByText('Transcribe'));
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/recordings/n9'));
        expect(api.post).toHaveBeenCalledWith(
            '/api/transcriptions/from-nextcloud',
            { nextcloud_path: '/Talk/tok/call.ogg', title: 'call' },
            { retry: false, timeoutMs: 600_000 },
        );
    });

    it('shows a failed import', async () => {
        (api.post as jest.Mock).mockRejectedValue(new Error('Nextcloud refused the download'));
        await renderScreen();
        await fireEvent.press(await screen.findByText('Transcribe'));
        expect(await screen.findByText('Import failed')).toBeTruthy();
    });

    it('offers nothing to import for a Meet call without a recording', async () => {
        await renderScreen();
        await screen.findByText('call.ogg');
        await fireEvent.press(screen.getByText('Google Meet'));
        expect(await screen.findByText('Sprint review')).toBeTruthy();
        expect(screen.getByText('No recording')).toBeTruthy();
        expect(screen.queryByText('Transcribe')).toBeNull();
    });
});
