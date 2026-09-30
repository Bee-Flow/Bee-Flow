import { fileFacts, normaliseFolder, titleFromFileName } from './imports';
import { applyRecordAnswer, meetChipStatus, upcomingRows } from './rows';
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
