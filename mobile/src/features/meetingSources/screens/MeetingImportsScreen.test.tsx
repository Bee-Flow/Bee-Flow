/**
 * The import screen: a Talk recording becomes a note that then opens, a Meet
 * recording without a file cannot be imported, and a failed import is shown.
 * On the Meet tab the week's automatic imports stay visible when there are no
 * recordings to list, a parked job is not called a failure, and an expired
 * Google grant says so instead of "no recordings". A Meet import runs in the
 * background on the server: the screen follows its job to the note, its
 * failure or Google's wait. A Nextcloud import still running when the screen
 * is opened again keeps its row busy.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders, testQueryClient } from '@/shared/testing/renderWithProviders';
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

const renderScreen = (queryClient = testQueryClient()) =>
    renderWithProviders(
        <ToastProvider>
            <MeetingImportsScreen />
        </ToastProvider>,
        { queryClient },
    );

type Job = { id: string; title: string | null; status: string; errorCode: string | null; transcriptionId: string | null };

/** The Meet tab with one recording that is ready, and the job list `jobs()` answers at the time of each read. */
function meetWith(jobs: () => Job[]) {
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (path === '/api/transcriptions/gmeet-recordings') {
            return Promise.resolve({
                connection: { googleConnected: true, meetScopesGranted: true },
                items: [{ eventId: 'e1', title: 'Sprint review', recordingState: 'available' }],
            });
        }
        if (path === '/api/transcriptions/gmeet-imports') return Promise.resolve({ items: jobs() });
        return Promise.resolve(ANSWERS[path] ?? null);
    });
    (api.post as jest.Mock).mockResolvedValue({ jobId: 'j1', status: 'pending' });
}

const meetJob = (patch: Partial<Job>): Job => ({ id: 'j1', title: null, status: 'pending', errorCode: null, transcriptionId: null, ...patch });

const importMeet = async () => {
    await renderScreen();
    await fireEvent.press(await screen.findByText('Google Meet'));
    expect(await screen.findByText('Sprint review')).toBeTruthy();
    await fireEvent.press(screen.getByText('Transcribe'));
};

const meetImportCalls = () =>
    (api.get as jest.Mock).mock.calls.filter(([path]) => path === '/api/transcriptions/gmeet-imports').length;

const answer = (over: Record<string, unknown> = {}) =>
    (api.get as jest.Mock).mockImplementation((path: string) => {
        const all = { ...ANSWERS, ...over };
        const value = all[path];
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? null);
    });

const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Job ${id}`,
    meetingStart: '2026-11-02T10:00:00Z',
    status,
    errorCode: null,
    transcriptionId: null,
    ...extra,
});

const openMeetTab = async () => {
    await renderScreen();
    await screen.findByText('call.ogg');
    await fireEvent.press(screen.getByText('Google Meet'));
};

beforeEach(() => {
    jest.clearAllMocks();
    answer();
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

    it('follows a Meet import the server runs in the background until its note opens', async () => {
        let current = meetJob({});
        meetWith(() => [current]);
        await importMeet();
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
        // Running: the row stays busy, and nothing claims Google is still preparing it.
        expect(await screen.findByLabelText('Transcribing…')).toBeTruthy();
        expect(screen.queryByText(/Google is still preparing/)).toBeNull();
        const readsWhileRunning = meetImportCalls();
        current = meetJob({ status: 'ingested', transcriptionId: 'n5' });
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/recordings/n5'), { timeout: 8000 });
        expect(meetImportCalls()).toBeGreaterThan(readsWhileRunning);
    });

    it('says why a background Meet import failed', async () => {
        meetWith(() => ((api.post as jest.Mock).mock.calls.length ? [meetJob({ status: 'failed', errorCode: 'no_drive_access' })] : []));
        await importMeet();
        expect(await screen.findByText('Your organisation does not allow access to this recording.')).toBeTruthy();
        expect(screen.getByText('Transcribe')).toBeTruthy();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('says Google is still preparing only when the job waits for Google', async () => {
        meetWith(() => ((api.post as jest.Mock).mock.calls.length ? [meetJob({ status: 'awaiting_artifacts' })] : []));
        await importMeet();
        expect(await screen.findByText(/Google is still preparing this recording/)).toBeTruthy();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('keeps a Nextcloud import that is still running busy when the screen is opened again', async () => {
        (api.post as jest.Mock).mockImplementation(() => new Promise(() => {}));
        const queryClient = testQueryClient();
        await renderScreen(queryClient);
        expect(await screen.findByText('call.ogg')).toBeTruthy();
        await fireEvent.press(screen.getByText('Transcribe'));
        expect(await screen.findByLabelText('Transcribing…')).toBeTruthy();

        // Back, and in again: the server is still transcribing the first request.
        await cleanup();
        await renderScreen(queryClient);
        expect(await screen.findByText('call.ogg')).toBeTruthy();
        expect(screen.getByLabelText('Transcribing…')).toBeTruthy();
        expect(screen.queryByText('Transcribe')).toBeNull();
        expect(api.post).toHaveBeenCalledTimes(1);
    });

    it('offers nothing to import for a Meet call without a recording', async () => {
        await renderScreen();
        await screen.findByText('call.ogg');
        await fireEvent.press(screen.getByText('Google Meet'));
        expect(await screen.findByText('Sprint review')).toBeTruthy();
        expect(screen.getByText('No recording')).toBeTruthy();
        expect(screen.queryByText('Transcribe')).toBeNull();
    });

    it('labels a job waiting on a colleague or on a reconnect apart from a failed one', async () => {
        answer({
            '/api/transcriptions/gmeet-imports': {
                items: [
                    job('dup', 'duplicate'),
                    job('reauth', 'needs_reauth', { errorCode: 'needs_reauth' }),
                    job('wait', 'pending'),
                    job('bad', 'download_failed', { errorCode: 'download_failed' }),
                ],
            },
        });
        await openMeetTab();
        expect(await screen.findByText('Imported by a colleague')).toBeTruthy();
        expect(screen.getAllByText('Import failed')).toHaveLength(1);
        expect(screen.getByText('Processing…')).toBeTruthy();
        await fireEvent.press(screen.getByText('Reconnect Google'));
        expect(mockPush).toHaveBeenCalledWith('/integrations');
    });

    it('keeps the automatic imports visible when there are no Meet recordings', async () => {
        answer({
            '/api/transcriptions/gmeet-recordings': { connection: { googleConnected: true, meetScopesGranted: false }, items: [] },
            '/api/transcriptions/gmeet-imports': { items: [job('j1', 'download_failed', { title: 'Weekly sync', errorCode: 'download_failed' })] },
        });
        await openMeetTab();
        expect(await screen.findByText('No Meet recordings found')).toBeTruthy();
        expect(await screen.findByText('Weekly sync')).toBeTruthy();
    });

    it('keeps the automatic imports visible when the recordings could not be read', async () => {
        answer({
            '/api/transcriptions/gmeet-recordings': new Error('Google did not answer'),
            '/api/transcriptions/gmeet-imports': { items: [job('j1', 'download_failed', { title: 'Weekly sync', errorCode: 'download_failed' })] },
        });
        await openMeetTab();
        expect(await screen.findByText('Weekly sync')).toBeTruthy();
    });

    it('says the Google access expired instead of only "no recordings"', async () => {
        answer({
            '/api/transcriptions/gmeet-recordings': {
                connection: { googleConnected: false, meetScopesGranted: true, hasSettingsScope: false, needsReauth: true },
                items: [],
            },
        });
        await openMeetTab();
        expect(await screen.findByText(/Your Google access expired/)).toBeTruthy();
        await fireEvent.press(screen.getByText('Reconnect'));
        expect(mockPush).toHaveBeenCalledWith('/integrations');
    });
});
