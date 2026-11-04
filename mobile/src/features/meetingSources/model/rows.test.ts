import { fileFacts, normaliseFolder, titleFromFileName } from './imports';
import { applyRecordAnswer, meetChipStatus, talkChipStatus, upcomingRows } from './rows';
import type { MeetMeeting, MeetMeetings, TalkMeeting, TalkMeetings } from './types';

const base = {
    end: null,
    excluded: false,
    recordReason: null,
    recordDecided: true,
    tags: [],
    attendees: [],
};

const talkMeeting = (patch: Partial<TalkMeeting> = {}): TalkMeeting => ({
    ...base,
    title: 'Talk',
    start: '2026-09-25T10:00:00Z',
    uid: 'u',
    talkToken: 'tok',
    organizer: null,
    isModerator: true,
    status: 'will_record',
    recordedNoteId: null,
    ...patch,
});

const meetMeeting = (patch: Partial<MeetMeeting> = {}): MeetMeeting => ({
    ...base,
    title: 'Meet',
    start: '2026-09-25T09:00:00Z',
    eventId: 'e',
    meetingCode: null,
    organizerEmail: null,
    organizerSelf: true,
    recordingControlledByHost: false,
    importedNoteId: null,
    status: 'will_import',
    ...patch,
});

const talk = (meetings: TalkMeeting[], recordingEnabled = true): TalkMeetings => ({
    recordingEnabled,
    autoRecord: true,
    recordingMode: 'audio',
    postSummaryBack: undefined,
    meetings,
});

const meet = (meetings: MeetMeeting[], granted = true): MeetMeetings => ({
    connection: { googleConnected: true, meetScopesGranted: granted, hasSettingsScope: false, needsReauth: false },
    autoImport: true,
    autoRecordConfig: false,
    meetings,
});

describe('upcoming rows', () => {
    it('merges both providers by start time', () => {
        const rows = upcomingRows(talk([talkMeeting()]), meet([meetMeeting()]));
        expect(rows.map((r) => r.key)).toEqual(['gmeet:e', 'talk:u:tok']);
    });

    it('keys two events in one Talk room apart', () => {
        const rows = upcomingRows(talk([talkMeeting({ uid: 'a' }), talkMeeting({ uid: 'b' }), talkMeeting({ uid: null })]), null);
        expect(rows.map((r) => r.key)).toEqual(['talk:a:tok', 'talk:b:tok', 'talk::tok']);
    });

    it('locks a switch that can change nothing', () => {
        expect(upcomingRows(talk([talkMeeting()], false), null)[0]?.toggleable).toBe(false);
        expect(upcomingRows(talk([talkMeeting({ isModerator: false })]), null)[0]?.toggleable).toBe(false);
        expect(upcomingRows(talk([talkMeeting({ isModerator: null })]), null)[0]?.toggleable).toBe(true);
        expect(upcomingRows(null, meet([meetMeeting()], false))[0]?.toggleable).toBe(false);
        // A colleague's meeting under importScope 'organizer': only its organiser imports it.
        expect(upcomingRows(null, meet([meetMeeting({ status: 'not_organizer' })]))[0]?.toggleable).toBe(false);
        expect(upcomingRows(null, meet([meetMeeting()]))[0]?.toggleable).toBe(true);
    });

    it("derives a Meet row's chip as the web does", () => {
        expect(meetChipStatus(meetMeeting({ status: 'not_organizer' }), true)).toBe('not_organizer');
        expect(meetChipStatus(meetMeeting({ importedNoteId: 'n' }), true)).toBe('recorded');
        expect(meetChipStatus(meetMeeting({ excluded: true }), true)).toBe('upcoming');
        expect(meetChipStatus(meetMeeting(), false)).toBe('upcoming');
        expect(meetChipStatus(meetMeeting({ recordingControlledByHost: true }), true)).toBe('manual_record');
        expect(meetChipStatus(meetMeeting(), true)).toBe('will_record');
    });

    it("settles a toggled meeting on the server's effective answer", () => {
        expect(applyRecordAnswer(talkMeeting({ excluded: true }), true)).toMatchObject({
            excluded: false,
            recordReason: 'opted_in',
            recordDecided: true,
        });
        expect(applyRecordAnswer(talkMeeting(), false)).toMatchObject({ excluded: true, recordReason: 'opted_out' });
    });
});

describe('a Talk row after a toggle', () => {
    // What the toggle mutation writes to the cache: the switch, then the server's answer.
    const toggled = (m: TalkMeeting, effectiveRecord: boolean) =>
        applyRecordAnswer({ ...m, excluded: !m.excluded }, effectiveRecord);

    it('stops saying "Will record" once switched off', () => {
        const row = upcomingRows(talk([toggled(talkMeeting(), false)]), null)[0];
        expect(row?.meeting.excluded).toBe(true);
        expect(row?.status).toBe('upcoming');
    });

    it('says "Will record" once switched on under auto-record', () => {
        const off = talkMeeting({ excluded: true, status: 'upcoming' });
        expect(upcomingRows(talk([toggled(off, true)]), null)[0]?.status).toBe('will_record');
        const undecided = talkMeeting({ recordDecided: false, status: 'decides_at_start' });
        expect(upcomingRows(talk([toggled(undecided, false)]), null)[0]?.status).toBe('upcoming');
    });

    it("derives a Talk row's chip in the server's order", () => {
        const on = { autoRecord: true, recordingEnabled: true };
        expect(talkChipStatus(talkMeeting({ status: 'recording_now', excluded: true }), on)).toBe('recording_now');
        expect(talkChipStatus(talkMeeting({ recordedNoteId: 'n' }), on)).toBe('recorded');
        expect(talkChipStatus(talkMeeting({ isModerator: false }), on)).toBe('not_moderator');
        expect(talkChipStatus(talkMeeting(), on)).toBe('will_record');
        expect(talkChipStatus(talkMeeting(), { autoRecord: false, recordingEnabled: true })).toBe('upcoming');
        expect(talkChipStatus(talkMeeting(), { autoRecord: true, recordingEnabled: false })).toBe('upcoming');
        expect(talkChipStatus(talkMeeting({ isModerator: null, recordDecided: false }), on)).toBe('decides_at_start');
        expect(talkChipStatus(talkMeeting({ isModerator: null }), on)).toBe('upcoming');
    });
});

describe('upcoming order', () => {
    it("sorts an all-day event at local midnight of its own day", () => {
        // Local times, whatever zone the test runs in: two evening calls today, tomorrow's all-day event.
        const local = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).toISOString();
        const rows = upcomingRows(
            talk([
                talkMeeting({ uid: 'call20', start: local(4, 20) }),
                talkMeeting({ uid: 'call18', start: local(4, 18) }),
                talkMeeting({ uid: 'early', start: local(5, 1) }),
            ]),
            meet([meetMeeting({ eventId: 'offsite', start: '2026-11-05' })]),
        );
        expect(rows.map((r) => (r.provider === 'talk' ? r.meeting.uid : r.meeting.eventId))).toEqual([
            'call18',
            'call20',
            'offsite',
            'early',
        ]);
    });
});

describe('import helpers', () => {
    it('titles a note after its file', () => {
        expect(titleFromFileName('Board call 2026-09-01.ogg')).toBe('Board call 2026-09-01');
        expect(titleFromFileName('.ogg')).toBe('meeting');
    });

    it('says what is known about a file', () => {
        expect(fileFacts(null, null)).toBe('');
        expect(fileFacts(2048, null)).toContain('KB');
    });

    it('makes a typed folder absolute', () => {
        expect(normaliseFolder('Recordings/')).toBe('/Recordings');
        expect(normaliseFolder('  ')).toBe('/Recordings');
        expect(normaliseFolder('/Audio')).toBe('/Audio');
    });
});
