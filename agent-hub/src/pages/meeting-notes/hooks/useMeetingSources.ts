import { useMeetingSourcesQuery } from '@/api/queries/meetingNotesConnections';

/**
 * useMeetingSources — which live-meeting sources can actually feed Meeting
 * Notes for this account: Nextcloud Talk (any connection: connector / OAuth /
 * app-password) and Google Meet (Google connected).
 *
 * Gates the "Upcoming" tab on the Meeting Notes page: an org on e.g. Outlook
 * calendar + Teams has neither source, and a tab that can never show a
 * meeting shouldn't exist for them. Uses the two cheap settings endpoints
 * (no calendar scans). Best-effort: any error or non-OK (e.g. unlicensed
 * 403) counts as unavailable.
 *
 * @returns {{ talk: boolean, gmeet: boolean, loading: boolean }}
 */
export default function useMeetingSources() {
    return useMeetingSourcesQuery();
}
