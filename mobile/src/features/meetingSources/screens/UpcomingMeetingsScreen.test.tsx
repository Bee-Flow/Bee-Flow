/**
 * The Upcoming screen: both providers in one list, a switch that settles on
 * the server's effective answer (and says why when a wider rule won), and the
 * banners for what stands in a provider's way.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { UpcomingMeetingsScreen } from './UpcomingMeetingsScreen';

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
    connection: { googleConnected: false, meetScopesGranted: false },
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
});
