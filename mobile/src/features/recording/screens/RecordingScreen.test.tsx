/**
 * The meeting screen, rendered against canned notes in each of its three
 * states, and the two writes whose shape matters most: a checkbox tap sends
 * the whole action-item list back with every field intact, and the first
 * delete goes out unconfirmed.
 */

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { downloadToCache } from '@/core/api/downloadFile';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { RecordingScreen } from './RecordingScreen';

jest.setTimeout(30_000);

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// The Insights section floats the viewer's own row to the top of People.
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me', displayName: 'Tom' } }) }));
// ESM renderers and native share plumbing that nothing here exercises.
jest.mock('@/shared/markdown/Markdown', () => {
    const { Text } = jest.requireActual('react-native');
    return { Markdown: ({ value }: { value: string }) => <Text>{value}</Text> };
});
jest.mock('../components/MeetingChatSheet', () => ({ MeetingChatSheetBody: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('@/core/api/downloadFile', () => ({ downloadToCache: jest.fn() }));

const COMPLETED = {
    id: 'm1',
    title: 'Weekly sync',
    status: 'completed',
    isOwner: true,
    summary: 'We agreed on the plan.',
    actionItems: [
        { id: 'ai-1', text: 'Send the offer', source: 'ai', destination: { kind: 'kb', ref: 'kb1' } },
        { id: 'u-1', text: 'Book a room', source: 'user', done: true },
    ],
    decisions: [{ text: 'Ship on Friday' }],
    questions: [
        { text: 'Who pays?', open: true },
        { text: 'Answered one', open: false },
    ],
    chapters: [{ title: 'Intro', start: '00:00' }],
    speakers: [{ id: 'Tom' }],
    segments: [{ speaker: 'Tom', start: 0, end: 4, text: 'Morning all' }],
    audio: { available: true },
};

function answer(note: Record<string, unknown>) {
    (api.get as jest.Mock).mockImplementation((path: string) =>
        Promise.resolve(path === '/api/transcriptions/m1' ? note : null),
    );
}

/**
 * A finished mutation is garbage-collected on a five-minute timer by default,
 * which keeps a single-file jest run alive after its last test. Infinity
 * schedules no timer at all.
 */
const client = () =>
    new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
        },
    });

const renderMeeting = () =>
    renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <RecordingScreen id="m1" />
            </ConfirmProvider>
        </ToastProvider>,
        { queryClient: client() },
    );

beforeEach(() => {
    jest.clearAllMocks();
    (api.patch as jest.Mock).mockResolvedValue({});
    (api.post as jest.Mock).mockResolvedValue({});
    (api.delete as jest.Mock).mockResolvedValue({ success: true });
    (downloadToCache as jest.Mock).mockResolvedValue({ uri: 'file:///cache/meeting-audio-m1', contentType: null });
});

describe('RecordingScreen', () => {
    it('lays out a finished note above its transcript', async () => {
        answer(COMPLETED);
        await renderMeeting();
        expect(await screen.findByText('We agreed on the plan.')).toBeTruthy();
        expect(screen.getByText('Send the offer')).toBeTruthy();
        expect(screen.getByText('Ship on Friday')).toBeTruthy();
        expect(screen.getByText('Who pays?')).toBeTruthy();
        expect(screen.queryByText('Answered one')).toBeNull();
        expect(screen.getByText('Intro')).toBeTruthy();
        expect(screen.getByText('Morning all')).toBeTruthy();
    });

    it('sends the whole action-item list back, every field intact, when one is ticked', async () => {
        answer(COMPLETED);
        await renderMeeting();
        await fireEvent.press(await screen.findByText('Send the offer'));
        // The write refreshes the note; wait for that re-read before leaving.
        await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
        expect(api.patch).toHaveBeenCalledWith('/api/transcriptions/m1', {
            actionItems: [
                { id: 'ai-1', text: 'Send the offer', source: 'ai', destination: { kind: 'kb', ref: 'kb1' }, done: true },
                { id: 'u-1', text: 'Book a room', source: 'user', done: true },
            ],
        });
    });

    it('explains a note that is still processing', async () => {
        answer({ id: 'm1', title: 'Fresh', status: 'processing' });
        await renderMeeting();
        expect(await screen.findByText('Working on it')).toBeTruthy();
    });

    it('shows why a note failed and re-runs it from the saved audio', async () => {
        answer({
            id: 'm1',
            status: 'failed',
            isOwner: true,
            summary: 'Transcription failed: the engine timed out',
            audio: { available: true },
        });
        await renderMeeting();
        expect(await screen.findByText('the engine timed out')).toBeTruthy();
        await fireEvent.press(screen.getByText('Try again'));
        expect(await screen.findByText('Transcribing again')).toBeTruthy();
        expect(api.post).toHaveBeenCalledWith('/api/transcriptions/m1/reprocess', undefined, { retry: false });
    });

    it('asks before deleting, and sends the first delete unconfirmed', async () => {
        answer(COMPLETED);
        await renderMeeting();
        await fireEvent.press(await screen.findByLabelText('More actions'));
        await fireEvent.press(await screen.findByText('Delete meeting'));
        expect(await screen.findByText('Delete this meeting?')).toBeTruthy();
        await fireEvent.press(screen.getByText('Delete'));
        await waitFor(() => expect(mockBack).toHaveBeenCalled());
        expect(api.delete).toHaveBeenCalledWith('/api/transcriptions/m1', undefined);
    });

    it('edits the tags and sends the whole list back', async () => {
        answer({ ...COMPLETED, tags: ['sales'] });
        await renderMeeting();
        await fireEvent.press(await screen.findByText('Add tag'));
        await fireEvent.changeText(await screen.findByPlaceholderText('Add tag…'), 'q3, board');
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.patch).toHaveBeenCalledWith('/api/transcriptions/m1', { tags: ['sales', 'q3', 'board'] }),
        );
    });

    it('downloads the recording only when play is pressed', async () => {
        answer(COMPLETED);
        await renderMeeting();
        await screen.findByText('We agreed on the plan.');
        expect(downloadToCache).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByLabelText('Play'));
        await waitFor(() =>
            expect(downloadToCache).toHaveBeenCalledWith('/api/transcriptions/m1/audio', 'meeting-audio-m1', {
                signal: expect.any(AbortSignal),
                reuse: true,
                sessionScoped: true,
            }),
        );
    });

    it('plays from a transcript turn when it is tapped', async () => {
        answer(COMPLETED);
        await renderMeeting();
        await fireEvent.press(await screen.findByText('Morning all'));
        await waitFor(() => expect(downloadToCache).toHaveBeenCalled());
    });
});
