/**
 * The Upcoming screen's setup banners appear only for a source this person
 * can use: Talk's missing recording backend for an account known to have
 * Nextcloud (and only when it matters), "Connect Google" only where Google is
 * set up on the installation.
 */

import { showConnectGoogle, showTalkBackendNotice } from './banners';
import type { MeetConnection, TalkMeetings } from './types';

const talk = (over: Partial<TalkMeetings> = {}): TalkMeetings => ({
    recordingEnabled: false,
    autoRecord: false,
    recordingMode: 'audio',
    postSummaryBack: undefined,
    meetings: [],
    ...over,
});
const oneMeeting = [{ talkToken: 'tok' }] as unknown as TalkMeetings['meetings'];

const connection = (over: Partial<MeetConnection> = {}): MeetConnection => ({
    googleConfigured: true,
    googleConnected: false,
    meetScopesGranted: false,
    hasSettingsScope: false,
    needsReauth: false,
    ...over,
});

describe('showTalkBackendNotice', () => {
    it('stays quiet while Nextcloud is unknown or not connected', () => {
        expect(showTalkBackendNotice(talk({ meetings: oneMeeting, autoRecord: true }), undefined)).toBe(false);
        expect(showTalkBackendNotice(talk({ meetings: oneMeeting, autoRecord: true }), false)).toBe(false);
    });

    it('stays quiet when connected without a Talk meeting and with auto-record off', () => {
        expect(showTalkBackendNotice(talk(), true)).toBe(false);
    });

    it('warns when connected and a Talk meeting is listed, or auto-record is on', () => {
        expect(showTalkBackendNotice(talk({ meetings: oneMeeting }), true)).toBe(true);
        expect(showTalkBackendNotice(talk({ autoRecord: true }), true)).toBe(true);
    });

    it('stays quiet when the backend is there or Talk did not answer', () => {
        expect(showTalkBackendNotice(talk({ recordingEnabled: true, meetings: oneMeeting }), true)).toBe(false);
        expect(showTalkBackendNotice(undefined, true)).toBe(false);
    });
});

describe('showConnectGoogle', () => {
    it('asks to connect only when Google is configured and the account is not connected', () => {
        expect(showConnectGoogle(connection())).toBe(true);
        expect(showConnectGoogle(connection({ googleConfigured: false }))).toBe(false);
        expect(showConnectGoogle(connection({ googleConnected: true }))).toBe(false);
        expect(showConnectGoogle(connection({ needsReauth: true }))).toBe(false);
        expect(showConnectGoogle(null)).toBe(false);
    });
});
