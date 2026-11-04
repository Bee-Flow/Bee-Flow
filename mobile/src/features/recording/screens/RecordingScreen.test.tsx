/**
 * The meeting screen, rendered against canned notes in each of its three
 * states, and the two writes whose shape matters most: a checkbox tap sends
 * the whole action-item list back with every field intact, and the first
 * delete goes out unconfirmed. Below that, the meeting writes whose ORDER
 * matters, as hooks: ticking action items one after another (each PATCH
 * replaces the whole list), and what a delete or a lost note leaves behind on
 * the phone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { api, ApiError } from '@/core/api/client';
import { downloadToCache, removeCachedDownload } from '@/core/api/downloadFile';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders, testQueryClient } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { RecordingScreen } from './RecordingScreen';
import { recordingKeys } from '../api/keys';
import { useDeleteTranscription, useToggleActionItem } from '../hooks/mutations';
import { useTranscription } from '../hooks/queries';
import type { Transcription } from '../model/types';

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
jest.mock('@/core/api/downloadFile', () => ({ downloadToCache: jest.fn(), removeCachedDownload: jest.fn() }));

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

    it('asks before re-transcribing a finished note, and sends nothing on cancel', async () => {
        answer(COMPLETED);
        await renderMeeting();
        await fireEvent.press(await screen.findByLabelText('More actions'));
        await fireEvent.press(await screen.findByText('Re-transcribe from the audio'));
        expect(await screen.findByText('Re-transcribe this recording?')).toBeTruthy();
        expect(api.post).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Re-transcribe this recording?')).toBeNull());
        expect(api.post).not.toHaveBeenCalled();

        await fireEvent.press(screen.getByLabelText('More actions'));
        await fireEvent.press(await screen.findByText('Re-transcribe from the audio'));
        await fireEvent.press(await screen.findByText('Re-transcribe'));
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

// The hook tests below set their own api answers, so the screen tests' answer() does not leak in.
const NOTE = {
    id: 'm1',
    title: 'Weekly sync',
    status: 'completed',
    actionItems: [
        { id: 'a', text: 'A', done: false },
        { id: 'b', text: 'B', done: false },
        { id: 'c', text: 'C', done: false },
    ],
} as unknown as Transcription;

function setup() {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, wrapper };
}

const done = (note: Transcription | null | undefined) => (note?.actionItems ?? []).map((item) => Boolean(item.done));

describe('useToggleActionItem', () => {
    it('keeps every tick when items are tapped faster than the server answers', async () => {
        const { client, wrapper } = setup();
        client.setQueryData(recordingKeys.detail('m1'), NOTE);
        // Each PATCH stays open until the test releases it, like a slow network.
        const releases: (() => void)[] = [];
        let stored = NOTE.actionItems;
        (api.patch as jest.Mock).mockImplementation(
            (_path: string, body: { actionItems: Transcription['actionItems'] }) =>
                new Promise<void>((resolve) => releases.push(() => {
                    stored = body.actionItems;
                    resolve();
                })),
        );
        (api.get as jest.Mock).mockImplementation(async () => ({ ...NOTE, actionItems: stored }));
        const invalidate = jest.spyOn(client, 'invalidateQueries');

        const { result } = await renderHook(() => useToggleActionItem('m1'), { wrapper });
        const view = () => done(client.getQueryData<Transcription>(recordingKeys.detail('m1')));

        await act(async () => result.current(0));
        expect(view()).toEqual([true, false, false]);
        await act(async () => result.current(1));
        await act(async () => result.current(2));
        // The checkboxes move on the tap, not after the round trip.
        expect(view()).toEqual([true, true, true]);
        // One PATCH at a time, in tap order.
        expect(api.patch).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 3; i++) {
            await waitFor(() => expect(releases).toHaveLength(i + 1));
            await act(async () => releases[i]!());
        }
        const bodies = (api.patch as jest.Mock).mock.calls.map((call) => done(call[1] as Transcription));
        expect(bodies).toEqual([[true, false, false], [true, true, false], [true, true, true]]);
        // Read back once, after the last tick, not between two of them.
        await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: recordingKeys.detail('m1') }));
        expect(invalidate.mock.calls.filter(([f]) => JSON.stringify(f) === JSON.stringify({ queryKey: recordingKeys.detail('m1') }))).toHaveLength(1);
        expect(done({ actionItems: stored } as Transcription)).toEqual([true, true, true]);
    });

    it('reads the note back after a refused PATCH, so the screen shows what the server kept', async () => {
        const { client, wrapper } = setup();
        client.setQueryData(recordingKeys.detail('m1'), NOTE);
        (api.patch as jest.Mock).mockRejectedValue(new Error('offline'));
        const onError = jest.fn();
        const invalidate = jest.spyOn(client, 'invalidateQueries');
        const { result } = await renderHook(() => useToggleActionItem('m1', { onError }), { wrapper });
        await act(async () => result.current(0));
        await waitFor(() => expect(onError).toHaveBeenCalled());
        expect(invalidate).toHaveBeenCalledWith({ queryKey: recordingKeys.detail('m1') });
    });
});

describe('the phone copy of a recording', () => {
    it('is deleted with the meeting', async () => {
        (api.delete as jest.Mock).mockResolvedValue({ success: true });
        const { wrapper } = setup();
        const { result } = await renderHook(() => useDeleteTranscription('m1'), { wrapper });
        await act(async () => {
            await result.current.mutateAsync(false);
        });
        expect(removeCachedDownload).toHaveBeenCalledWith('meeting-audio-m1', { sessionScoped: true });
    });

    it('is kept when the delete is refused', async () => {
        (api.delete as jest.Mock).mockRejectedValue(new ApiError('HTTP 500', { status: 500 }));
        const { wrapper } = setup();
        const { result } = await renderHook(() => useDeleteTranscription('m1'), { wrapper });
        await act(async () => {
            await result.current.mutateAsync(false).catch(() => undefined);
        });
        expect(removeCachedDownload).not.toHaveBeenCalled();
    });

    it('is dropped when the note answers 404 (deleted elsewhere, or no longer shared)', async () => {
        (api.get as jest.Mock).mockRejectedValue(new ApiError('HTTP 404', { status: 404 }));
        const { wrapper } = setup();
        const { result } = await renderHook(() => useTranscription('m1'), { wrapper });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(removeCachedDownload).toHaveBeenCalledWith('meeting-audio-m1', { sessionScoped: true });
    });
});
