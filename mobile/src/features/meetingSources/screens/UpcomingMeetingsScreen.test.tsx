/**
 * The Upcoming screen: both providers in one list, a switch that settles on
 * the server's effective answer (and says why when a wider rule won), and the
 * banners for what stands in a provider's way. Below that, the useUpcoming
 * hook with two switches of the same provider in flight at once: one
 * useMutation serves every row, so the first row's feedback (a wider rule kept
 * it off, or its error) must not hang on mutate()'s per-call callbacks, which
 * the second row's mutate() detaches. Each row is busy until its own answer is
 * back.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders, testQueryClient } from '@/shared/testing/renderWithProviders';

import { UpcomingMeetingsScreen } from './UpcomingMeetingsScreen';
import { useUpcoming } from '../hooks/useUpcoming';
import type { RecordAnswer, TalkMeetings } from '../model/types';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const TALK = {
    recordingEnabled: true,
    autoRecord: true,
    recordingMode: 'audio',
    postSummaryBack: false,
    meetings: [
        {
            uid: 'u1',
            talkToken: 'tok1',
            title: 'Board meeting',
            start: '2026-09-25T10:00:00Z',
            end: '2026-09-25T11:00:00Z',
            attendees: ['a@x.nl', 'b@x.nl', 'c@x.nl'],
            isModerator: true,
            excluded: false,
            status: 'will_record',
            recordReason: 'opted_in',
            recordDecided: true,
        },
    ],
};

const MEET = {
    connection: { googleConfigured: true, googleConnected: false, meetScopesGranted: false },
    autoImport: false,
    meetings: [],
};


beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('/talk-meetings') ? TALK : MEET),
    );
});

describe('UpcomingMeetingsScreen', () => {
    it('lists the meeting with its facts, and the footer for Talk', async () => {
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText('Board meeting')).toBeTruthy();
        expect(screen.getByText('Will record')).toBeTruthy();
        expect(screen.getByText('3 participants ·')).toBeTruthy();
        expect(screen.getByText(/Bee Flow posts nothing back into the conversation/)).toBeTruthy();
        expect(screen.getByText(/Connect Google Workspace/)).toBeTruthy();
    });

    it('switches a meeting off and explains a wider rule that keeps it off', async () => {
        (api.patch as jest.Mock).mockResolvedValue({ ok: true, record: true, effectiveRecord: false, overridden: true });
        await renderWithProviders(<UpcomingMeetingsScreen />);
        await fireEvent(await screen.findByLabelText('Record Board meeting'), 'valueChange', false);
        await waitFor(() =>
            expect(api.patch).toHaveBeenCalledWith(
                '/api/transcriptions/talk-meetings/tok1',
                { record: false, eventUid: 'u1' },
                { retry: false },
            ),
        );
        expect(await screen.findByText('Skip')).toBeTruthy();
        expect(await screen.findByText(/Kept off by a wider rule/)).toBeTruthy();
    });

    it('says when Talk could not be read instead of claiming there is nothing', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            path.endsWith('/talk-meetings') ? Promise.reject(new Error('Nextcloud down')) : Promise.resolve(MEET),
        );
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText("Couldn't load Nextcloud Talk meetings")).toBeTruthy();
        expect(screen.queryByText('No upcoming meetings')).toBeNull();
    });

    it('says the Google access expired rather than asking to connect Google', async () => {
        const expired = { ...MEET, connection: { googleConfigured: true, googleConnected: false, meetScopesGranted: true, needsReauth: true } };
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path.endsWith('/talk-meetings') ? TALK : expired),
        );
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText(/Your Google access expired/)).toBeTruthy();
        expect(screen.queryByText(/Connect Google Workspace/)).toBeNull();
        await fireEvent.press(screen.getByText('Reconnect'));
        expect(mockPush).toHaveBeenCalledWith('/integrations');
    });

    it('does not ask to connect Google when the installation has no Google set up', async () => {
        const unconfigured = { ...MEET, connection: { googleConfigured: false, googleConnected: false, meetScopesGranted: false } };
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path.endsWith('/talk-meetings') ? TALK : unconfigured),
        );
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText('Board meeting')).toBeTruthy();
        expect(screen.queryByText(/Connect Google Workspace/)).toBeNull();
    });
});

describe('UpcomingMeetingsScreen: the Talk recording-backend banner', () => {
    const NO_BACKEND = { ...TALK, recordingEnabled: false };
    const answer = (nextcloud: unknown) => (path: string) => {
        if (path.endsWith('/talk-meetings')) return Promise.resolve(NO_BACKEND);
        if (path === '/api/talk-notes-settings/user/me') return nextcloud instanceof Error ? Promise.reject(nextcloud) : Promise.resolve(nextcloud);
        return Promise.resolve(MEET);
    };

    it('warns an account with Nextcloud connected and a Talk meeting listed', async () => {
        (api.get as jest.Mock).mockImplementation(answer({ nextcloudConnected: true, recordingEnabled: false }));
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText(/Nextcloud Talk recording backend isn't configured/)).toBeTruthy();
    });

    it('stays quiet for an account without Nextcloud', async () => {
        (api.get as jest.Mock).mockImplementation(answer({ nextcloudConnected: false, recordingEnabled: false }));
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText('Board meeting')).toBeTruthy();
        await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/talk-notes-settings/user/me', expect.anything()));
        expect(screen.queryByText(/Nextcloud Talk recording backend isn't configured/)).toBeNull();
    });

    it('stays quiet while it is unknown whether Nextcloud is connected', async () => {
        (api.get as jest.Mock).mockImplementation(answer(new Error('settings unavailable')));
        await renderWithProviders(<UpcomingMeetingsScreen />);
        expect(await screen.findByText('Board meeting')).toBeTruthy();
        expect(screen.queryByText(/Nextcloud Talk recording backend isn't configured/)).toBeNull();
    });
});

const meeting = (token: string, title: string, start: string) => ({
    uid: `u-${token}`,
    talkToken: token,
    title,
    start,
    end: null,
    excluded: true,
    recordReason: 'opted_out',
    recordDecided: true,
    tags: [],
    attendees: [],
    participantCount: null,
    organizer: null,
    isModerator: true,
    status: 'upcoming' as const,
    recordedNoteId: null,
});

const TWO_ROOMS: TalkMeetings = {
    recordingEnabled: true,
    autoRecord: false,
    recordingMode: 'audio',
    postSummaryBack: false,
    meetings: [meeting('tokA', 'Meeting A', '2030-01-01T10:00:00Z'), meeting('tokB', 'Meeting B', '2030-01-01T11:00:00Z')],
};

/** One PATCH per room token, answered or failed by the test. */
const pending: Record<string, { resolve: (a: RecordAnswer) => void; reject: (e: unknown) => void }> = {};

const MEET_EMPTY = {
    connection: { googleConnected: false, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false },
    autoImport: false,
    autoRecordConfig: false,
    meetings: [],
};

async function mountWithTwoRows() {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = await renderHook(() => useUpcoming(), { wrapper });
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(2));
    const [first, second] = hook.result.current.rows;
    return { hook, first: first!, second: second! };
}

describe('useUpcoming toggle', () => {
    beforeEach(() => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path.endsWith('/talk-meetings') ? TWO_ROOMS : MEET_EMPTY),
        );
        // setTalkRecord PATCHes /api/transcriptions/talk-meetings/<token>; each stays open until the test answers it.
        (api.patch as jest.Mock).mockImplementation(
            (path: string) =>
                new Promise<RecordAnswer>((resolve, reject) => {
                    pending[decodeURIComponent(path.split('/').pop() ?? '')] = { resolve, reject };
                }),
        );
    });

    it('keeps the first row\'s "kept off by a wider rule" when a second row of the provider is switched meanwhile', async () => {
        const { hook, first, second } = await mountWithTwoRows();
        await act(async () => hook.result.current.toggle(first));
        await act(async () => hook.result.current.toggle(second));
        expect(hook.result.current.isBusy(first.key)).toBe(true);
        expect(hook.result.current.isBusy(second.key)).toBe(true);

        await act(async () => pending.tokA!.resolve({ effectiveRecord: false, overridden: true }));
        await waitFor(() => expect(hook.result.current.overridden[first.key]).toBe(true));
        expect(hook.result.current.isBusy(first.key)).toBe(false);
        // The second row is still waiting for its answer, so its switch stays locked.
        expect(hook.result.current.isBusy(second.key)).toBe(true);

        await act(async () => pending.tokB!.resolve({ effectiveRecord: true, overridden: false }));
        await waitFor(() => expect(hook.result.current.isBusy(second.key)).toBe(false));
        expect(hook.result.current.overridden[second.key]).toBe(false);
        await hook.unmount();
    });

    it('shows the first row\'s error when a second row of the provider is switched meanwhile', async () => {
        const { hook, first, second } = await mountWithTwoRows();
        await act(async () => hook.result.current.toggle(first));
        await act(async () => hook.result.current.toggle(second));
        const failure = new Error('Nextcloud did not answer');

        await act(async () => pending.tokA!.reject(failure));
        await waitFor(() => expect(hook.result.current.errors[first.key]).toBe(failure));
        expect(hook.result.current.errors[second.key]).toBeUndefined();

        await act(async () => pending.tokB!.resolve({ effectiveRecord: true, overridden: false }));
        await waitFor(() => expect(hook.result.current.isBusy(second.key)).toBe(false));
        await hook.unmount();
    });
});
