import type { TranslateFn } from '@/hooks/useTranslation';

type Sentence = (t: TranslateFn) => string;

const NEEDS_SCOPES: Sentence = (t) => t('meetings.import_error_needs_scopes', 'Meeting access has not been granted. Reconnect your account to add it.');
const NO_RECORDING: Sentence = (t) => t('meetings.import_error_no_recording', 'This meeting has no recording or transcript.');
const ACCESS_DISABLED: Sentence = (t) => t('meetings.import_error_access_disabled', 'Your organisation does not allow access to this recording.');
const FAILED: Sentence = (t) => t('meetings.import_error_failed', 'The import failed. Try again in a moment.');

/** One literal t() call per code, so the key extraction sees every key. */
const SENTENCES: Record<string, Sentence> = {
    not_connected: (t) => t('meetings.import_error_not_connected', 'Your account is not connected any more. Reconnect it and try again.'),
    needs_reauth: (t) => t('meetings.import_error_needs_reauth', 'Access expired. Reconnect your account and try again.'),
    needs_teams_scopes: NEEDS_SCOPES,
    needs_meet_scopes: NEEDS_SCOPES,
    not_organizer: (t) => t('meetings.import_error_not_organizer', 'Only the organiser of a meeting can import it.'),
    no_recording: NO_RECORDING,
    no_conference: NO_RECORDING,
    recording_too_large: (t) => t('meetings.import_error_too_large', 'The recording is too large to import.'),
    transcript_access_disabled: (t) => t('meetings.import_error_transcript_api_off', 'Your Teams admin has switched off API access to meeting transcripts.'),
    speaker_attribution_disabled: (t) => t('meetings.import_error_speaker_attribution_off', 'Your Teams admin does not allow speaker names in transcripts, so this transcript cannot be imported. A recording would work.'),
    no_drive_access: ACCESS_DISABLED,
    empty_transcription: (t) => t('meetings.import_error_empty', 'The recording contained no speech to transcribe.'),
    timeout: (t) => t('meetings.import_error_timeout', 'The import took too long. Check the meeting notes later, or try again.'),
    already_imported: (t) => t('meetings.import_error_already_imported', 'Someone else already imported this meeting. Ask them to share the meeting note with you.'),
    provider_not_allowed: (t) => t('meetings.import_error_provider_not_allowed', 'That transcription engine is not enabled for this workspace.'),
    // Teams failures with their own cause (server: teamsArtifacts classifyGraphFailure, teams.js).
    graph_forbidden: (t) => t('meetings.import_error_graph_forbidden', 'Microsoft refused access to this meeting. A permission, licence or Teams policy blocks it. Your admin can run the Teams test.'),
    meeting_not_available: (t) => t('meetings.import_error_meeting_not_available', 'Microsoft has no online meeting for this calendar entry. It may have expired.'),
    application_access_policy_missing: (t) => t('meetings.import_error_access_policy', 'Your organisation\'s Teams application access policy does not allow Bee Flow for this account.'),
    calendar_forbidden: (t) => t('meetings.import_error_calendar_forbidden', 'Microsoft refused access to your calendar.'),
    graph_throttled: (t) => t('meetings.import_error_throttled', 'Microsoft is limiting requests right now. Try again in a few minutes.'),
    graph_unavailable: (t) => t('meetings.import_error_graph_unavailable', 'Microsoft Graph did not answer properly. Try again in a few minutes.'),
    download_failed: (t) => t('meetings.import_error_download_failed', 'The recording could not be downloaded from Microsoft. Try again.'),
    too_many_imports: (t) => t('meetings.import_error_too_many', 'Too many imports are running. Wait for one to finish.'),
};

/**
 * The sentence for the stable failure code a meeting import job carries
 * (server: teamsAutoImport / gmeetAutoImport). An unknown code gets the
 * generic failure sentence.
 */
export function importErrorText(t: TranslateFn, code: string | null | undefined): string {
    const sentence = code && Object.prototype.hasOwnProperty.call(SENTENCES, code) ? SENTENCES[code] : FAILED;
    return sentence(t);
}
