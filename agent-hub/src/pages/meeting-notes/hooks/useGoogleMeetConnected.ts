import { useGoogleMeetConnectedQuery } from '@/api/queries/meetingNotesConnections';

/**
 * useGoogleMeetConnected — probes whether the current user has a Google
 * connection usable for Meet imports.
 *
 * Backed by the Google-Meet-notes settings endpoint, whose `connection` block
 * reports `{ googleConnected, meetScopesGranted }`. `connected` means the
 * account is connected AND has the Meet scopes; `needsReconsent` means the
 * account was authorized before the Meet scopes existed — such users still see
 * Meet UI, with a re-consent CTA instead of data.
 *
 * Probes lazily (only once `enabled` is true) so we don't fire a Google
 * capability probe on every app load — CaptureModal is mounted app-wide but
 * only needs this when the user actually opens it. Defaults to hidden and
 * stays hidden on any error / unlicensed account.
 *
 * @param {boolean} enabled - start the probe (e.g. when the modal opens)
 * @returns {{ connected: boolean, needsReconsent: boolean, loading: boolean }}
 *   connection status and whether the probe is still in flight
 */
export default function useGoogleMeetConnected(enabled: boolean = true) {
    return useGoogleMeetConnectedQuery(enabled);
}
