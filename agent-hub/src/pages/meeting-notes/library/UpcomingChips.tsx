import { Dot, FileText } from 'lucide-react';
import { kindColorVar, kindTint } from '@/components/shared/kindColors';
import { parseWhen } from '../lib/upcomingMeta';
import type { GmeetMeeting, StatusChipProps, TalkMeeting, TeamsMeeting } from './UpcomingMeetings.types';

/**
 * The status chip of an Upcoming row and the chip status each provider's row
 * derives locally (UpcomingMeetings). Derived on the client so an optimistic
 * toggle updates the chip, and the footer that reads it, without a round-trip;
 * each mirrors its route's status logic.
 */

export function StatusChip({ status, onOpenNote, t }: StatusChipProps) {
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium';
    const meetTint = { background: kindTint('meeting', 14), color: kindColorVar('meeting') };
    const muted = { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' };
    switch (status) {
        case 'recording_now':
            return <span className={base} style={meetTint}><Dot className="w-3.5 h-3.5 animate-pulse" aria-hidden="true" /> {t('meetings.upcoming_recording', 'Recording')}</span>;
        case 'will_record':
            return <span className={base} style={meetTint}>{t('meetings.upcoming_will_record', 'Will record')}</span>;
        case 'recorded':
            return (
                <button type="button" onClick={onOpenNote} className={base} style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success-ink)' }}>
                    <FileText className="w-3 h-3" aria-hidden="true" /> {t('meetings.upcoming_note_created', 'Note created')}
                </button>
            );
        case 'decides_at_start':
            // Not "Upcoming": the server will still count, at the start of the call, who
            // is really in it. A bare "Upcoming" reads as "nothing happens", and that is
            // precisely what can then happen.
            return (
                <span className={base} style={muted} title={t('meetings.upcoming_decides_hint', 'Bee Flow counts who is in the call when it starts; the calendar invite does not say.')}>
                    {t('meetings.upcoming_decides', 'Decides at start')}
                </span>
            );
        case 'not_moderator':
            return <span className={base} style={muted}>{t('meetings.upcoming_not_moderator', 'Not a moderator')}</span>;
        case 'not_organizer':
            return <span className={base} style={muted}>{t('meetings.upcoming_organizer_only', 'Organizer only')}</span>;
        case 'manual_record_teams':
            return (
                <span className={`${base} bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning-ink)]`}
                    title={t('meetings.upcoming_manual_teams_hint', 'Start the recording in Teams — it will be imported afterwards.')}>
                    {t('meetings.upcoming_record_in_teams', 'Record in Teams')}
                </span>
            );
        case 'manual_record':
            return (
                <span className={base} title={t('meetings.upcoming_manual_hint', 'Start the recording in Google Meet — it will be imported afterwards.')} style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning-ink)' }}>
                    {t('meetings.upcoming_record_in_meet', 'Record in Meet')}
                </span>
            );
        default:
            return <span className={base} style={muted}>{t('meetings.upcoming_upcoming', 'Upcoming')}</span>;
    }
}

// Chip status for a Meet row, derived locally so the optimistic exclusion
// toggle updates the chip without a round-trip (mirrors the server's status
// logic, plus the host-controls-recording refinement).
export function gmeetChipStatus(m: GmeetMeeting, autoImport: boolean) {
    if (m.status === 'not_organizer') return 'not_organizer';
    if (m.importedNoteId || m.status === 'imported') return 'recorded';
    if (m.excluded || !autoImport) return 'upcoming';
    return m.recordingControlledByHost ? 'manual_record' : 'will_record';
}

// Chip status for a Teams row. Only the organizer can import, and Teams'
// "record automatically" is switched on for them when the settings allow it;
// otherwise the organizer starts the recording in Teams.
export function teamsChipStatus(m: TeamsMeeting, autoImport: boolean, autoRecordArmed: boolean) {
    if (m.status === 'organizer_only') return 'not_organizer';
    if (m.importedNoteId) return 'recorded';
    if (m.excluded || !autoImport) return 'upcoming';
    return autoRecordArmed ? 'will_record' : 'manual_record_teams';
}

// Chip status for a Talk row, derived locally like the two above so the
// optimistic toggle updates the chip (and the post-back footer, which reads
// it) at once. Mirrors nextcloud.js and the mobile rows.ts.
export function talkChipStatus(m: TalkMeeting, autoRecord: boolean, recordingEnabled: boolean) {
    if (m.status === 'recording_now') return 'recording_now';
    if (m.recordedNoteId || m.status === 'recorded') return 'recorded';
    if (m.isModerator === false) return 'not_moderator';
    if (autoRecord && recordingEnabled && !m.excluded && m.isModerator === true) return 'will_record';
    if (!m.recordDecided) return 'decides_at_start';
    return 'upcoming';
}

/** Start time for sorting: a date-only value is local midnight, an unknown start sorts first. */
export const startMs = (start: string | null | undefined) => parseWhen(start)?.date.getTime() ?? 0;
