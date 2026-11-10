import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/transcriptionsApi', () => ({
    listTalkMeetings: vi.fn(),
    setMeetingRecord: vi.fn(),
    listGoogleMeetMeetings: vi.fn(),
    setGoogleMeetMeetingRecord: vi.fn(),
    listTeamsMeetings: vi.fn(),
    setTeamsMeetingRecord: vi.fn(),
}));
vi.mock('@/api/microsoftOAuthPopup', () => ({ openMicrosoftOAuthPopup: vi.fn() }));
vi.mock('@/lib/googleOAuthPopup', () => ({ openGoogleOAuthPopup: vi.fn() }));
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { openMicrosoftOAuthPopup } from '@/api/microsoftOAuthPopup';
import { listTalkMeetings, setMeetingRecord, listGoogleMeetMeetings, setGoogleMeetMeetingRecord, listTeamsMeetings, setTeamsMeetingRecord } from '@/api/transcriptionsApi';
import { openGoogleOAuthPopup } from '@/lib/googleOAuthPopup';
import UpcomingMeetings from './UpcomingMeetings';

const talkMeeting = (over = {}) => ({
    talkToken: 'tok1', uid: 'uid1', title: 'Talk standup',
    start: '2026-07-18T09:00:00Z', end: '2026-07-18T09:30:00Z',
    excluded: false, status: 'will_record', isModerator: true, recordedNoteId: null,
    ...over,
});
const gmeetMeeting = (over = {}) => ({
    eventId: 'ev1', iCalUID: 'ic1', title: 'Meet planning',
    start: '2026-07-18T08:00:00Z', end: '2026-07-18T08:30:00Z',
    organizerEmail: 'me@example.com', organizerSelf: true,
    meetingCode: 'abc-defg-hij', meetLink: 'https://meet.google.com/abc-defg-hij',
    excluded: false, recordingControlledByHost: false, importedNoteId: null, status: 'will_import',
    ...over,
});
const talkPayload = (meetings = [], over = {}) => ({ recordingEnabled: true, recordingMode: 'audio', meetings, ...over });
const gmeetPayload = (meetings = [], over = {}) => ({
    connection: { googleConnected: true, meetScopesGranted: true, hasSettingsScope: true, needsReauth: false },
    autoImport: true, meetings,
    ...over,
});

const teamsMeeting = (over = {}) => ({
    eventId: 'tev1', seriesMasterId: 'sm1', title: 'Teams review',
    start: '2026-07-18T10:00:00Z', end: '2026-07-18T10:30:00Z',
    organizerSelf: true, attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }],
    joinUrl: 'https://teams.microsoft.com/l/x', excluded: false, recordReason: 'auto', recordDecided: true,
    importedNoteId: null, status: 'will_import',
    ...over,
});
const teamsPayload = (meetings = [], over = {}) => ({
    connection: { microsoftConnected: true, teamsScopesGranted: true, hasMeetingWriteScope: true, hasTranscriptScope: true, needsReauth: false },
    autoImport: true, autoRecordConfig: true, meetings,
    ...over,
});

const toggles = (container) => container.querySelectorAll('button[aria-pressed]');

describe('UpcomingMeetings', () => {
    beforeEach(() => {
        listTalkMeetings.mockReset().mockResolvedValue(talkPayload());
        setMeetingRecord.mockReset().mockResolvedValue({});
        listGoogleMeetMeetings.mockReset().mockResolvedValue(gmeetPayload());
        setGoogleMeetMeetingRecord.mockReset().mockResolvedValue({});
        openGoogleOAuthPopup.mockReset().mockResolvedValue({ success: true });
        listTeamsMeetings.mockReset().mockResolvedValue(teamsPayload([], { connection: { microsoftConnected: false } }));
        setTeamsMeetingRecord.mockReset().mockResolvedValue({});
        openMicrosoftOAuthPopup.mockReset().mockResolvedValue({ success: true });
    });

    it('lists Teams meetings: organizer rows toggle, others are "Organizer only" and locked', async () => {
        listTeamsMeetings.mockResolvedValue(teamsPayload([
            teamsMeeting(),
            teamsMeeting({ eventId: 'tev2', title: 'Their meeting', organizerSelf: false, status: 'organizer_only' }),
        ]));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Teams review');
        expect(screen.getAllByText('Teams')).toHaveLength(2);
        expect(screen.getByText('Will record')).toBeInTheDocument();
        expect(screen.getByText('Organizer only')).toBeInTheDocument();
        const [mine, theirs] = toggles(container);
        expect(mine.disabled).toBe(false);
        expect(theirs.disabled).toBe(true);
        expect(screen.getByText(/Microsoft Teams: colleagues in your organisation/)).toBeInTheDocument();
    });

    it('toggles a Teams row with its series id and reconnects when the Teams permissions are missing', async () => {
        const user = userEvent.setup();
        listTeamsMeetings.mockResolvedValue(teamsPayload([teamsMeeting({ excluded: true, status: 'excluded' })]));
        setTeamsMeetingRecord.mockResolvedValue({ effectiveRecord: true, overridden: false });
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Teams review');
        await user.click(toggles(container)[0]);
        expect(setTeamsMeetingRecord).toHaveBeenCalledWith('tev1', true, { seriesMasterId: 'sm1' });

        cleanup();
        listTeamsMeetings.mockResolvedValue(teamsPayload([], {
            connection: { microsoftConnected: true, teamsScopesGranted: false, hasMeetingWriteScope: false },
        }));
        render(<UpcomingMeetings />);
        await user.click(await screen.findByRole('button', { name: 'Reconnect' }));
        expect(openMicrosoftOAuthPopup).toHaveBeenCalled();
    });

    it('merges both providers sorted by start time with provider chips', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()]));
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()])); // starts before the Talk one
        const { container } = render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        await screen.findByText('Meet planning');
        expect(screen.getByText('Talk')).toBeInTheDocument();
        expect(screen.getByText('Meet')).toBeInTheDocument();

        const text = container.textContent;
        expect(text.indexOf('Meet planning')).toBeLessThan(text.indexOf('Talk standup'));
        expect(toggles(container)).toHaveLength(2);
    });

    it('shows a Talk error card while still rendering Meet rows when only Talk fails', async () => {
        listTalkMeetings.mockRejectedValue(new Error('talk backend down'));
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()]));
        render(<UpcomingMeetings />);

        await screen.findByText("Couldn't load Nextcloud Talk meetings");
        expect(screen.getByText('talk backend down')).toBeInTheDocument();
        expect(screen.getByText('Meet planning')).toBeInTheDocument();
        expect(screen.queryByText("Couldn't load Google Meet meetings")).not.toBeInTheDocument();
    });

    it('renders the connect-Google prompt when Google is configured but not connected, without errors or reconnect banner', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([], {
            connection: { googleConfigured: true, googleConnected: false, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false },
        }));
        render(<UpcomingMeetings />);

        await screen.findByText(/Connect Google Workspace to see your Meet meetings here/);
        expect(screen.getByRole('link', { name: /Settings → Connections/ })).toHaveAttribute('href', '/app/settings/integrations');
        expect(screen.queryByText("Couldn't load Google Meet meetings")).not.toBeInTheDocument();
        expect(screen.queryByText(/doesn't include Meet permissions/)).not.toBeInTheDocument();
    });

    it('shows the reconnect banner when connected without Meet scopes and reloads after the popup', async () => {
        const user = userEvent.setup();
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([], {
            connection: { googleConnected: true, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false },
        }));
        render(<UpcomingMeetings />);

        await screen.findByText(/doesn't include Meet permissions yet — reconnect to enable auto-import/);
        expect(screen.queryByText(/Connect Google Workspace to see your Meet meetings/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Reconnect' }));
        await waitFor(() => expect(listGoogleMeetMeetings).toHaveBeenCalledTimes(2));
        expect(openGoogleOAuthPopup).toHaveBeenCalledWith(expect.objectContaining({ apiBase: '' }));
    });

    it('toggles a Meet row optimistically and keeps it on success', async () => {
        const user = userEvent.setup();
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ excluded: true, status: 'excluded' })]));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Meet planning');

        const toggle = toggles(container)[0];
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await user.click(toggle);
        expect(toggle).toHaveAttribute('aria-pressed', 'true'); // optimistic

        await waitFor(() => expect(setGoogleMeetMeetingRecord).toHaveBeenCalledWith('ev1', true, { meetingCode: 'abc-defg-hij' }));
        expect(listGoogleMeetMeetings).toHaveBeenCalledTimes(1); // no reload on success
    });

    it('reverts a failed Meet toggle by reload and shows the row error for classified failures', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ excluded: true, status: 'excluded' })]));
        const err = Object.assign(new Error('Meet permissions missing'), { code: 'needs_meet_scopes' });
        setGoogleMeetMeetingRecord.mockRejectedValue(err);
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Meet planning');

        // Sync on purpose: awaiting user.click would let the rejection and the reload land before the optimistic state is read.
        fireEvent.click(toggles(container)[0]);
        expect(toggles(container)[0]).toHaveAttribute('aria-pressed', 'true'); // optimistic

        await screen.findByText('Meet permissions missing');
        expect(listGoogleMeetMeetings).toHaveBeenCalledTimes(2); // revert-by-reload
        await waitFor(() => expect(toggles(container)[0]).toHaveAttribute('aria-pressed', 'false'));
    });

    it('disables the Meet toggle when Meet scopes are missing', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()], {
            connection: { googleConnected: true, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false },
        }));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Meet planning');
        expect(toggles(container)[0]).toBeDisabled();
    });

    it('renders manual_record and not_organizer chips for Meet rows', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([
            gmeetMeeting({ eventId: 'ev1', title: 'Hosted elsewhere', organizerSelf: false, recordingControlledByHost: true }),
            gmeetMeeting({ eventId: 'ev2', title: 'Organizer gated', start: '2026-07-18T11:00:00Z', status: 'not_organizer' }),
        ]));
        render(<UpcomingMeetings />);

        const manual = await screen.findByText('Record in Meet');
        expect(manual).toHaveAttribute('title', 'Start the recording in Google Meet — it will be imported afterwards.');
        expect(screen.getByText('Organizer only')).toBeInTheDocument();
    });

    it('opens the imported note from the Meet status chip', async () => {
        const user = userEvent.setup();
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ importedNoteId: 42, status: 'imported' })]));
        const onOpenNote = vi.fn();
        render(<UpcomingMeetings onOpenNote={onOpenNote} />);

        await user.click(await screen.findByRole('button', { name: /Note created/ }));
        expect(onOpenNote).toHaveBeenCalledWith(42);
    });

    it('keeps the Talk toggle flow: optimistic, revert-by-reload, and says why on the row', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()]));
        setMeetingRecord.mockRejectedValue(new Error('boom'));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Talk standup');

        const toggle = toggles(container)[0];
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        // Sync on purpose: awaiting user.click would let the rejection and the reload land before the optimistic state is read.
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-pressed', 'false'); // optimistic OFF

        await waitFor(() => expect(listTalkMeetings).toHaveBeenCalledTimes(2)); // revert-by-reload
        expect(setMeetingRecord).toHaveBeenCalledWith('tok1', false, 'uid1');
        await waitFor(() => expect(toggles(container)[0]).toHaveAttribute('aria-pressed', 'true'));
        // An uncoded failure gets the plain fallback, never the raw message.
        expect(screen.getByText("Couldn't update this meeting.")).toBeInTheDocument();
        expect(screen.queryByText('boom')).not.toBeInTheDocument();
    });

    it('explains a Meet toggle that failed without an error code (network TypeError)', async () => {
        const user = userEvent.setup();
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ excluded: true, status: 'excluded' })]));
        setGoogleMeetMeetingRecord.mockRejectedValue(new TypeError('Failed to fetch'));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Meet planning');

        await user.click(toggles(container)[0]);
        await screen.findByText("Couldn't update this meeting.");
        expect(listGoogleMeetMeetings).toHaveBeenCalledTimes(2); // revert-by-reload
        await waitFor(() => expect(toggles(container)[0]).toHaveAttribute('aria-pressed', 'false'));
    });

    it('explains a Teams toggle that failed with a generic 500 (no code)', async () => {
        const user = userEvent.setup();
        listTeamsMeetings.mockResolvedValue(teamsPayload([teamsMeeting({ excluded: true, status: 'excluded' })]));
        setTeamsMeetingRecord.mockRejectedValue(Object.assign(new Error('Internal server error'), { status: 500 }));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Teams review');

        await user.click(toggles(container)[0]);
        await screen.findByText("Couldn't update this meeting.");
        expect(screen.queryByText('Internal server error')).not.toBeInTheDocument();
        expect(listTeamsMeetings).toHaveBeenCalledTimes(2); // revert-by-reload
    });

    it('clears a Talk row error when the toggle is tried again and succeeds', async () => {
        const user = userEvent.setup();
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()]));
        setMeetingRecord.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ effectiveRecord: false });
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Talk standup');

        await user.click(toggles(container)[0]);
        await screen.findByText("Couldn't update this meeting.");
        await waitFor(() => expect(toggles(container)[0]).toHaveAttribute('aria-pressed', 'true'));
        await user.click(toggles(container)[0]);
        await waitFor(() => expect(screen.queryByText("Couldn't update this meeting.")).not.toBeInTheDocument());
    });

    it('does not suggest connecting Google when the installation has no Google OAuth client', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([], {
            connection: { googleConfigured: false, googleConnected: false, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false },
        }));
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()]));
        render(<UpcomingMeetings talkConnected />);
        await screen.findByText('Talk standup');
        expect(screen.queryByText(/Connect Google Workspace to see your Meet meetings/)).not.toBeInTheDocument();
        expect(screen.queryByText(/doesn't include Meet permissions/)).not.toBeInTheDocument();
    });

    it('does not suggest connecting Google when the server does not say whether Google is configured', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([], {
            connection: { googleConnected: false, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false },
        }));
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()]));
        render(<UpcomingMeetings talkConnected />);
        await screen.findByText('Talk standup');
        expect(screen.queryByText(/Connect Google Workspace to see your Meet meetings/)).not.toBeInTheDocument();
    });

    it('warns about the Talk recording backend when Nextcloud is connected and a Talk meeting is listed', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()], { recordingEnabled: false, autoRecord: false }));
        render(<UpcomingMeetings talkConnected />);
        await screen.findByText(/Nextcloud Talk recording backend isn't configured/);
    });

    it('warns about the Talk recording backend when Nextcloud is connected and auto-record is on, even without Talk meetings', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([], { recordingEnabled: false, autoRecord: true }));
        render(<UpcomingMeetings talkConnected />);
        await screen.findByText(/Nextcloud Talk recording backend isn't configured/);
    });

    it('stays quiet about the Talk recording backend when Nextcloud is connected but no Talk meeting is listed and auto-record is off', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([], { recordingEnabled: false, autoRecord: false }));
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()]));
        render(<UpcomingMeetings talkConnected />);
        await screen.findByText('Meet planning');
        expect(screen.queryByText(/Nextcloud Talk recording backend isn't configured/)).not.toBeInTheDocument();
    });

    it('stays quiet about the Talk recording backend while it is unknown whether Nextcloud is connected', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()], { recordingEnabled: false, autoRecord: true }));
        render(<UpcomingMeetings />);
        await screen.findByText('Talk standup');
        expect(screen.queryByText(/Nextcloud Talk recording backend isn't configured/)).not.toBeInTheDocument();
    });

    it('does not warn about the Talk recording backend to an account without Nextcloud', async () => {
        // What the route answers when resolveAuth fails: 200, recordingEnabled false, no meetings.
        listTalkMeetings.mockResolvedValue({ recordingEnabled: false, autoRecord: true, recordingMode: 'audio', count: 0, meetings: [] });
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()]));
        render(<UpcomingMeetings talkConnected={false} />);
        await screen.findByText('Meet planning');
        expect(screen.queryByText(/Nextcloud Talk recording backend isn't configured/)).not.toBeInTheDocument();
    });
});

describe('UpcomingMeetings: derived chips, occurrences, expired grants, auto-recording outcomes', () => {
    beforeEach(() => {
        listTalkMeetings.mockReset().mockResolvedValue(talkPayload());
        setMeetingRecord.mockReset().mockResolvedValue({});
        listGoogleMeetMeetings.mockReset().mockResolvedValue(gmeetPayload());
        setGoogleMeetMeetingRecord.mockReset().mockResolvedValue({});
        listTeamsMeetings.mockReset().mockResolvedValue(teamsPayload([], { connection: { microsoftConnected: false } }));
        setTeamsMeetingRecord.mockReset().mockResolvedValue({});
        openMicrosoftOAuthPopup.mockReset().mockResolvedValue({ success: true });
    });

    it('a will_record Talk row switched off drops "Will record" and the post-back footer at once', async () => {
        const user = userEvent.setup();
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()], { autoRecord: true, postSummaryBack: true }));
        let answer;
        setMeetingRecord.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Will record');
        expect(screen.getByTestId('upcoming-notice')).toHaveTextContent(/posted back into the conversation/);

        await user.click(toggles(container)[0]);
        expect(screen.queryByText('Will record')).not.toBeInTheDocument();
        expect(screen.queryByTestId('upcoming-notice')).not.toBeInTheDocument();
        answer({ effectiveRecord: false });
    });

    it('lists every occurrence of a recurring Talk meeting under its own key', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([
            talkMeeting({ title: 'Weekly A', start: '2026-07-18T09:00:00Z', recurrenceId: '2026-07-18T09:00:00Z' }),
            talkMeeting({ title: 'Weekly B', start: '2026-07-25T09:00:00Z', recurrenceId: '2026-07-25T09:00:00Z' }),
        ]));
        render(<UpcomingMeetings />);
        expect(await screen.findByText('Weekly A')).toBeInTheDocument();
        expect(screen.getByText('Weekly B')).toBeInTheDocument();
    });

    it('a Meet row of a colleague under organizer scope cannot be switched', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ status: 'not_organizer', organizerSelf: false })]));
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Organizer only');
        expect(toggles(container)[0]).toBeDisabled();
    });

    it('an expired Microsoft grant shows the reconnect banner, not an empty list in silence', async () => {
        listTeamsMeetings.mockResolvedValue(teamsPayload([], {
            connection: { microsoftConnected: true, teamsScopesGranted: true, hasMeetingWriteScope: true, needsReauth: true },
        }));
        render(<UpcomingMeetings />);
        expect(await screen.findByTestId('upcoming-teams-reauth')).toHaveTextContent(/connection has expired/);
    });

    it('says when a switch left the provider recording alone for one occurrence of a series', async () => {
        const user = userEvent.setup();
        listTeamsMeetings.mockResolvedValue(teamsPayload([teamsMeeting({ excluded: true, status: 'excluded' })]));
        setTeamsMeetingRecord.mockResolvedValue({ effectiveRecord: true, overridden: false, autoRecordingConfig: 'series_only' });
        const { container } = render(<UpcomingMeetings />);
        await screen.findByText('Teams review');
        await user.click(toggles(container)[0]);
        expect(await screen.findByTestId('upcoming-row-notice')).toHaveTextContent(/Teams records a series as a whole/);
    });
});
