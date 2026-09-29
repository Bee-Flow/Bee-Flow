import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * De Gepland-rij (M5) op het scherm: datumblok + `tijd · duur · deelnemers ·
 * provider`, de tags uit meeting_prefs, en de voetregel over wat er met de
 * ANDERE deelnemers gebeurt. De regels zelf staan in `../lib/upcomingMeta.js`
 * (en worden daar getoetst); hier gaat het erom dat de rij ze ook echt toont.
 */

vi.mock('../lib/transcriptionsApi', () => ({
    listTalkMeetings: vi.fn(),
    setMeetingRecord: vi.fn(),
    listGoogleMeetMeetings: vi.fn(),
    setGoogleMeetMeetingRecord: vi.fn(),
}));
vi.mock('../../../lib/googleOAuthPopup', () => ({ openGoogleOAuthPopup: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import UpcomingMeetings from './UpcomingMeetings';
import { listTalkMeetings, listGoogleMeetMeetings, setMeetingRecord } from '../lib/transcriptionsApi';

const talkMeeting = (over = {}) => ({
    talkToken: 'tok1', uid: 'uid1', title: 'Talk standup',
    start: '2026-07-18T09:00:00Z', end: '2026-07-18T09:30:00Z',
    organizer: { cn: 'Sanne', email: 'sanne@example.com' },
    attendees: [{ cn: 'Ines', email: 'ines@example.com' }, { cn: 'Joris', email: 'joris@example.com' }],
    excluded: false, status: 'will_record', isModerator: true, recordedNoteId: null,
    ...over,
});
const gmeetMeeting = (over = {}) => ({
    eventId: 'ev1', iCalUID: 'ic1', title: 'Meet planning',
    start: '2026-07-18T08:00:00Z', end: '2026-07-18T09:30:00Z',
    organizerEmail: 'me@example.com', organizerSelf: true,
    attendees: [{ email: 'me@example.com', self: true }, { email: 'ines@example.com' }],
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

const hhmm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const metaOf = async (title) => {
    await screen.findByText(title);
    return screen.getAllByTestId('upcoming-meta').map(el => el.textContent).join('\n');
};

describe('UpcomingMeetings — datumblok, meta en tags', () => {
    beforeEach(() => {
        listTalkMeetings.mockReset().mockResolvedValue(talkPayload());
        listGoogleMeetMeetings.mockReset().mockResolvedValue(gmeetPayload());
    });

    it('toont tijd · duur · deelnemers · provider voor een Meet-rij', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()]));
        render(<UpcomingMeetings />);

        const meta = await metaOf('Meet planning');
        expect(meta).toContain(`${hhmm('2026-07-18T08:00:00Z')}–${hhmm('2026-07-18T09:30:00Z')}`);
        expect(meta).toContain('1 hr 30 min');
        expect(meta).toContain('2 participants');
        expect(meta).toContain('Meet');
    });

    it('zegt "participants unknown" — niet "0 participants" — als de uitnodiging niemand noemt', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([
            talkMeeting({ attendees: [], organizer: null, recordReason: 'unknown_size', excluded: true }),
        ]));
        render(<UpcomingMeetings />);

        const meta = await metaOf('Talk standup');
        expect(meta).toContain('participants unknown');
        expect(meta).not.toContain('0 participants');
        expect(meta).not.toMatch(/\b0 /);
        // En de toggle vertelt waarom hij dan uit staat.
        expect(screen.getByRole('button', { name: 'Record Talk standup' }))
            .toHaveAttribute('title', "Off by default: the calendar doesn't say who is coming.");
    });

    it('een hele-dag-afspraak zegt "All day" en toont GEEN duur', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting({ start: '2026-07-18', end: '2026-07-19' })]));
        render(<UpcomingMeetings />);

        const meta = await metaOf('Talk standup');
        expect(meta).toContain('All day');
        expect(meta).not.toContain('min');
        expect(meta).not.toContain('hr');
        // Het datumblok toont wél de dag uit de uitnodiging.
        expect(screen.getByTestId('upcoming-date').textContent)
            .toContain(new Date(2026, 6, 18).toLocaleDateString(undefined, { day: 'numeric' }));
    });

    it('zonder begintijd staat er een agendaglyph met uitleg, geen verzonnen datum', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting({ start: null, end: null })]));
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        const block = screen.getByTestId('upcoming-date');
        expect(block).toHaveAttribute('title', 'This meeting has no start time in the calendar.');
        expect(block.textContent).toBe('');
    });

    it('rendert de tags uit meeting_prefs als chips, en geen tagrij als er geen zijn', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting({ tags: ['dataweging', ' spelersmonitor ', 42, ''] })]));
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()]));
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        const rows = screen.getAllByTestId('meeting-tags');
        expect(rows).toHaveLength(1);                       // alleen de Talk-rij heeft tags
        expect(within(rows[0]).getByText('dataweging')).toBeInTheDocument();
        expect(within(rows[0]).getByText('spelersmonitor')).toBeInTheDocument();
        expect(rows[0].textContent).not.toContain('42');
        // Read-only in dit paneel: er is nog geen route die tags op een AFSPRAAK
        // schrijft, dus ook geen knop die belooft dat het kan.
        expect(within(rows[0]).queryByText('Add tag')).not.toBeInTheDocument();
    });
});

describe('UpcomingMeetings — de voetregel belooft alleen wat de bot echt doet', () => {
    beforeEach(() => {
        listTalkMeetings.mockReset().mockResolvedValue(talkPayload());
        listGoogleMeetMeetings.mockReset().mockResolvedValue(gmeetPayload());
    });

    it('toont de write-back-zin alleen als de payload zegt dat postSummaryBack aan staat', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()], { postSummaryBack: true }));
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        const notice = screen.getByTestId('upcoming-notice').textContent;
        expect(notice).toContain('posted back into the conversation');
        // Ook mét write-back is het bericht `silent: true` — dus geen melding.
        expect(notice).toContain('nobody gets a notification');
    });

    it('doet geen enkele bewering als de payload postSummaryBack niet meestuurt', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()]));
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        expect(screen.queryByTestId('upcoming-notice')).not.toBeInTheDocument();
    });

    it('ontkent de write-back als de payload zegt dat hij uit staat', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([talkMeeting()], { postSummaryBack: false }));
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        expect(screen.getByTestId('upcoming-notice').textContent).toContain('posts nothing back into the conversation');
    });

    it('een Meet-rij voegt de leesrecht-zin toe — over een melding gaat hij niet', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting()]));
        render(<UpcomingMeetings />);

        await screen.findByText('Meet planning');
        const notice = screen.getByTestId('upcoming-notice').textContent;
        expect(notice).toContain('can read the note afterwards');
        expect(notice).toContain('does not notify them');
        // Zonder autoRecordConfig staat de opnamemelding-zin er NIET.
        expect(notice).not.toContain('auto-recording');
    });

    it('een uitgezette Meet-rij laat de voetregel leeg — geen notitie, geen gevolg om uit te leggen', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ excluded: true, status: 'excluded' })]));
        render(<UpcomingMeetings />);

        await screen.findByText('Meet planning');
        expect(screen.queryByTestId('upcoming-notice')).not.toBeInTheDocument();
    });
});

describe('UpcomingMeetings — het scherm zegt niet het tegenovergestelde van de server', () => {
    beforeEach(() => {
        listTalkMeetings.mockReset().mockResolvedValue(talkPayload());
        listGoogleMeetMeetings.mockReset().mockResolvedValue(gmeetPayload());
        setMeetingRecord.mockReset().mockResolvedValue({ ok: true, record: true, effectiveRecord: true, overridden: false });
    });

    it('een onbeslist gesprek heet niet "Skip" en niet "Upcoming"', async () => {
        // De engine telt bij de start van het gesprek nog wie er in zit. "Skip"
        // en een kale "Upcoming" beweren allebei dat er niets gebeurt.
        listTalkMeetings.mockResolvedValue(talkPayload([
            talkMeeting({ excluded: true, recordReason: 'unknown_size', recordDecided: false, status: 'decides_at_start' }),
        ]));
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        expect(screen.getAllByText('Decides at start').length).toBeGreaterThan(0);
        expect(screen.queryByText('Skip')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Record Talk standup/ }).getAttribute('title'))
            .toContain('counts who is in the call when it starts');
    });

    it('een beslist uitgezette rij zegt gewoon "Skip"', async () => {
        listTalkMeetings.mockResolvedValue(talkPayload([
            talkMeeting({ excluded: true, recordReason: 'small_meeting', recordDecided: true, status: 'upcoming' }),
        ]));
        render(<UpcomingMeetings />);
        await screen.findByText('Talk standup');
        expect(screen.getByText('Skip')).toBeInTheDocument();
    });

    it('de uitleg bij "participants unknown" komt ook echt in de rij terecht', async () => {
        // De regel wordt in de lib berekend en daar getoetst; niets keek of hij
        // de DOM haalde, dus `title={seg.title}` kon er ongemerkt uit vallen.
        listTalkMeetings.mockResolvedValue(talkPayload([
            talkMeeting({ attendees: [], organizer: null, recordReason: 'unknown_size', excluded: true }),
        ]));
        render(<UpcomingMeetings />);
        await screen.findByText('Talk standup');
        expect(screen.getByText('participants unknown').getAttribute('title'))
            .toContain("doesn't list who is coming");
    });

    it('een klik die door een bredere regel wordt overruled springt terug én legt uit', async () => {
        // Eén FALSE wint — de org-brede rij, of de serie. De PATCH kaatste de
        // vraag terug, de rij sprong op "Record" en stond bij de volgende load
        // weer op "Skip", zonder één woord waarom.
        listTalkMeetings.mockResolvedValue(talkPayload([
            talkMeeting({ excluded: true, recordReason: 'opted_out', recordDecided: true, status: 'upcoming' }),
        ]));
        setMeetingRecord.mockResolvedValue({ ok: true, record: true, effectiveRecord: false, overridden: true });
        render(<UpcomingMeetings />);

        await screen.findByText('Talk standup');
        const toggle = screen.getByRole('button', { name: /Record Talk standup/ });
        await act(async () => { fireEvent.click(toggle); });

        expect(screen.getByText('Skip')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Record Talk standup/ }).getAttribute('title'))
            .toContain('Kept off by a wider rule');
    });

    it('waarschuwt over Meets eigen opnamemelding zodra deze knop hem kan aanzetten', async () => {
        listGoogleMeetMeetings.mockResolvedValue(gmeetPayload([gmeetMeeting({ organizerSelf: true })], { autoRecordConfig: true }));
        render(<UpcomingMeetings />);

        await screen.findByText('Meet planning');
        const notice = screen.getByTestId('upcoming-notice').textContent;
        expect(notice).toContain('turns on Meet’s own auto-recording');
        expect(notice).toContain('announces a running recording to everyone');
    });

    it('zegt niets over de voetregel als er niets wordt opgenomen', async () => {
        // `!excluded` is de stand van de SCHAKELAAR, niet de uitkomst: hier
        // meldt de banner erboven dat de opnameback-end niet geconfigureerd is.
        listTalkMeetings.mockResolvedValue(talkPayload(
            [talkMeeting({ excluded: false, status: 'upcoming' })],
            { recordingEnabled: false, postSummaryBack: true },
        ));
        render(<UpcomingMeetings />);
        await screen.findByText('Talk standup');
        expect(screen.queryByTestId('upcoming-notice')).not.toBeInTheDocument();
    });

    it('meldt GEEN nul aan de rail als beide bronnen faalden', async () => {
        // "Upcoming 0" leest als "je hebt geen vergaderingen"; het was
        // "we konden ze niet ophalen".
        listTalkMeetings.mockRejectedValue(new Error('talk down'));
        listGoogleMeetMeetings.mockRejectedValue(new Error('meet down'));
        const onRowsChange = vi.fn();
        render(<UpcomingMeetings onRowsChange={onRowsChange} />);

        await screen.findByText("Couldn't load Nextcloud Talk meetings");
        expect(onRowsChange).toHaveBeenLastCalledWith(null);
    });
});
