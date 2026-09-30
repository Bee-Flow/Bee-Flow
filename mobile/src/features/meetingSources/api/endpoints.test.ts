/**
 * The meeting-source calls: paths, bodies, and what a thin or odd payload
 * reads as. Every shape is the handler's in server/routes/transcriptions/
 * nextcloud.js and gmeet.js.
 */

import { api } from '@/core/api/client';

import {
    importFromMeet,
    importFromNextcloud,
    listMeetImports,
    listMeetMeetings,
    listMeetRecordings,
    listNextcloudFiles,
    listTalkMeetings,
    listTalkRecordings,
    setMeetRecord,
    setTalkRecord,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('upcoming meetings', () => {
    it('reads Talk meetings, keeping "unknown" apart from false', async () => {
        get.mockResolvedValue({
            recordingEnabled: true,
            recordingMode: 'video',
            meetings: [{ uid: 'u1', talkToken: 'tok', title: 'Standup', isModerator: null, status: 'weird' }],
        });
        const out = await listTalkMeetings();
        expect(get.mock.calls[0][0]).toBe('/api/transcriptions/talk-meetings');
        expect(out.postSummaryBack).toBeUndefined();
        expect(out.meetings[0]).toMatchObject({ talkToken: 'tok', isModerator: null, status: 'upcoming', excluded: false });
    });

    it('reads Meet meetings with their connection', async () => {
        get.mockResolvedValue({
            connection: { googleConnected: true, meetScopesGranted: false },
            autoImport: true,
            meetings: [{ eventId: 'e1', title: 'Sync', excluded: true, importedNoteId: 'n1' }],
        });
        const out = await listMeetMeetings();
        expect(out.connection).toEqual({
            googleConnected: true,
            meetScopesGranted: false,
            hasSettingsScope: false,
            needsReauth: false,
        });
        expect(out.meetings[0]).toMatchObject({ eventId: 'e1', excluded: true, importedNoteId: 'n1' });
    });

    it('switches a Talk meeting and reads the effective answer', async () => {
        patch.mockResolvedValue({ ok: true, record: true, effectiveRecord: false, overridden: true });
        expect(await setTalkRecord('a b', true, 'uid-1')).toEqual({ effectiveRecord: false, overridden: true });
        expect(patch).toHaveBeenCalledWith(
            '/api/transcriptions/talk-meetings/a%20b',
            { record: true, eventUid: 'uid-1' },
            { retry: false },
        );
    });

    it('falls back to what was asked when an older server does not say', async () => {
        patch.mockResolvedValue({ ok: true });
        expect(await setMeetRecord('e1', false, null)).toEqual({ effectiveRecord: false, overridden: false });
        expect(patch.mock.calls[0][1]).toEqual({ record: false });
    });
});

describe('recordings to import', () => {
    it('drops Talk rooms without recordings', async () => {
        get.mockResolvedValue({
            rooms: [
                { token: 't1', name: 'Board', recordings: [{ name: 'a.ogg', path: '/Talk/t1/a.ogg', kind: 'audio' }] },
                { token: 't2', recordings: [] },
            ],
        });
        const rooms = await listTalkRecordings();
        expect(rooms).toHaveLength(1);
        expect(rooms[0]).toMatchObject({ token: 't1', name: 'Board' });
    });

    it('asks for one Nextcloud folder', async () => {
        get.mockResolvedValue({ items: [{ name: 'memo.m4a', path: '/Recordings/memo.m4a', size: 12 }, { name: 'x' }] });
        const files = await listNextcloudFiles('/Recordings');
        expect(files).toEqual([{ name: 'memo.m4a', path: '/Recordings/memo.m4a', size: 12, lastModified: null }]);
        expect(get).toHaveBeenCalledWith('/api/transcriptions/nextcloud-audio-files', {
            signal: undefined,
            query: { folder: '/Recordings' },
        });
    });

    it('reads Meet recordings and import jobs', async () => {
        get.mockResolvedValueOnce({ connection: { meetScopesGranted: true }, items: [{ eventId: 'e1', recordingState: '?' }] });
        const recordings = await listMeetRecordings();
        expect(recordings.items[0]?.recordingState).toBe('none');
        get.mockResolvedValueOnce({ items: [{ id: 'j1', status: 'ingested', transcriptionId: 'n1' }] });
        expect((await listMeetImports())[0]).toMatchObject({ id: 'j1', transcriptionId: 'n1', errorCode: null });
    });
});

describe('imports', () => {
    it('imports a Nextcloud file with the long deadline and no retry', async () => {
        post.mockResolvedValue({ id: 'n1', title: 'memo' });
        expect(await importFromNextcloud('/Recordings/memo.m4a', 'memo')).toEqual({ id: 'n1', pending: false });
        expect(post).toHaveBeenCalledWith(
            '/api/transcriptions/from-nextcloud',
            { nextcloud_path: '/Recordings/memo.m4a', title: 'memo' },
            { retry: false, timeoutMs: 600_000 },
        );
    });

    it('reads a 202 from Meet as pending', async () => {
        post.mockResolvedValue({ jobId: 'j1', status: 'awaiting_artifacts' });
        expect(await importFromMeet({ eventId: 'e1', meetingCode: 'abc-defg-hij', title: 'Sync' })).toEqual({
            id: null,
            pending: true,
        });
        expect(post.mock.calls[0][1]).toEqual({ event_id: 'e1', meeting_code: 'abc-defg-hij', title: 'Sync' });
    });
});
