import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * The sentence for the stable failure code a meeting import job carries
 * (server: teamsAutoImport / gmeetAutoImport). One literal t() call per code,
 * so the key extraction sees every key.
 */
export function importErrorText(t: TranslateFn, code: string | null | undefined): string {
    switch (code) {
        case 'not_connected': return t('meetings.import_error_not_connected', 'Your account is not connected any more. Reconnect it and try again.');
        case 'needs_reauth': return t('meetings.import_error_needs_reauth', 'Access expired. Reconnect your account and try again.');
        case 'needs_teams_scopes':
        case 'needs_meet_scopes': return t('meetings.import_error_needs_scopes', 'Meeting access has not been granted. Reconnect your account to add it.');
        case 'not_organizer': return t('meetings.import_error_not_organizer', 'Only the organiser of a meeting can import it.');
        case 'no_recording':
        case 'no_conference': return t('meetings.import_error_no_recording', 'This meeting has no recording or transcript.');
        case 'recording_too_large': return t('meetings.import_error_too_large', 'The recording is too large to import.');
        case 'transcript_access_disabled':
        case 'speaker_attribution_disabled':
        case 'no_drive_access': return t('meetings.import_error_access_disabled', 'Your organisation does not allow access to this recording.');
        case 'empty_transcription': return t('meetings.import_error_empty', 'The recording contained no speech to transcribe.');
        case 'timeout': return t('meetings.import_error_timeout', 'The import took too long. Check the meeting notes later, or try again.');
        default: return t('meetings.import_error_failed', 'The import failed. Try again in a moment.');
    }
}
