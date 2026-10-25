import { useNextcloudConnectedQuery } from '../../../api/queries/meetingNotesConnections';

/**
 * useNextcloudConnected — probes whether the current user has *any* Nextcloud
 * connection (connector / OAuth / saved app-password).
 *
 * Backed by the same `isConnected` check the settings page uses, surfaced via
 * the Talk-notes settings endpoint (`nextcloudConnected`). Used to gate
 * Nextcloud-only UI such as the "Nextcloud Talk" capture tile.
 *
 * Probes lazily (only once `enabled` is true) so we don't fire a Nextcloud
 * capability probe on every app load — CaptureModal is mounted app-wide but
 * only needs this when the user actually opens it. Defaults to false (hidden)
 * and stays false on any error / unlicensed account.
 *
 * @param {boolean} enabled - start the probe (e.g. when the modal opens)
 * @returns {{ connected: boolean, loading: boolean }} connection status and
 *   whether the probe is still in flight
 */
export default function useNextcloudConnected(enabled: boolean = true) {
    return useNextcloudConnectedQuery(enabled);
}
