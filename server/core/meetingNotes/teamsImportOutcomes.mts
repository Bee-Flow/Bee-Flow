/**
 * Teams import job codes that are expected outcomes, not failures: the meeting
 * was not recorded, the user does not organise it, or Microsoft has no online
 * meeting for the calendar entry. One list for the poller (it does not log
 * them as failures, teamsAutoImport.js QUIET_CODES) and the members overview
 * (it does not count them as failed imports, stores/teamsSetupStore.mts).
 */

export const TEAMS_EXPECTED_OUTCOME_CODES: readonly string[] = Object.freeze(['no_recording', 'not_organizer', 'meeting_not_available']);
