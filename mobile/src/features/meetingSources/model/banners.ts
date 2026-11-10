/**
 * When the Upcoming screen's setup banners appear, the same rules as the web
 * (agent-hub UpcomingMeetings): a banner only for a source this person can
 * actually use.
 */

import type { MeetConnection, TalkMeetings } from './types';

/**
 * Talk's recording backend is missing: news only to an account KNOWN to have
 * Nextcloud (`talkConnected === true`, not unknown), and only when it costs
 * something: a Talk meeting is listed, or auto-record is on and cannot run.
 */
export function showTalkBackendNotice(talk: TalkMeetings | undefined, talkConnected: boolean | undefined): boolean {
    if (talkConnected !== true || !talk || talk.recordingEnabled) return false;
    return talk.meetings.length > 0 || talk.autoRecord;
}

/**
 * "Connect Google": only when the installation has a Google OAuth client
 * (`googleConfigured`) and this account is neither connected nor expired.
 */
export function showConnectGoogle(connection: MeetConnection | null): boolean {
    return !!connection && connection.googleConfigured && !connection.needsReauth && !connection.googleConnected;
}
