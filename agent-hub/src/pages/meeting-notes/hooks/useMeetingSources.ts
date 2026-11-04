import { useMeetingSourcesQuery } from '@/api/queries/meetingNotesConnections';

/**
 * useMeetingSources — which live-meeting sources can actually feed Meeting
 * Notes for this account: Nextcloud Talk (any connection: connector / OAuth /
 * app-password), Google Meet (Google connected) and Microsoft Teams
 * (Microsoft connected with the Teams calendar/recording scopes).
 *
 * The result decides only whether the "Upcoming" pane is pre-mounted, so its
 * count badge is there before anyone opens it; the segment itself is always
 * shown. Uses the cheap settings endpoints (no calendar scans). Best-effort,
 * so any error or non-OK (e.g. unlicensed 403) counts as unavailable.
 *
 * @returns {{ talk: boolean, gmeet: boolean, teams: boolean, loading: boolean }}
 */
export default function useMeetingSources() {
    return useMeetingSourcesQuery();
}
