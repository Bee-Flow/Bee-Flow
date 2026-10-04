import React, { useState } from 'react';
import { Video, Loader2, RefreshCw, Download, Check, Clock } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import CaptureControls from './CaptureControls';
import { useRecorder } from '../hooks/RecorderContext';
import {
    useTeamsRecordings,
    useInvalidateTeamsMeetingNotes,
    type TeamsRecordingItem,
} from '../../../api/queries/teamsMeetingNotes';
import { openMicrosoftOAuthPopup } from '../../../lib/microsoftOAuthPopup';
import { API_BASE, authFetch } from '../../../utils/helpers';

/**
 * Manual import of a finished Microsoft Teams meeting. Lists the meetings the
 * user ORGANISED in the last week (Graph gives recordings to the organizer
 * only) with what Teams has for each: a recording (transcribed by Bee Flow's
 * own engine), only a transcript (imported with the Teams speaker names, no
 * audio), or nothing.
 *
 * Teams' colour is the theme's secondary accent, never the brand hex.
 */

function fmtDate(s: string | null): string {
    if (!s) return '';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function fmtDuration(start: string | null, end: string | null): string {
    const s = new Date(start || '').getTime();
    const e = new Date(end || '').getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return '';
    const mins = Math.round((e - s) / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

const PANEL = 'rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]';
const TEAMS_TILE = 'flex items-center justify-center bg-[color-mix(in_srgb,var(--accent-secondary)_12%,transparent)] text-[var(--accent-secondary)]';
const PRIMARY_BTN = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';
const ERROR_BOX = 'flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs bg-[color-mix(in_srgb,var(--error)_8%,var(--bg-secondary))] border-[var(--error)] text-[var(--text-primary)]';

interface ImportOutcome { ok?: boolean; pending?: boolean }

export default function TeamsImportPanel({ onComplete }: { onComplete?: () => void }) {
    const { t } = useTranslation();
    const { importFromTeams, settings, uploading, uploadStage, uploadError, clearError } = useRecorder();
    const recordings = useTeamsRecordings(true);
    const invalidate = useInvalidateTeamsMeetingNotes();
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
    const [reauthBusy, setReauthBusy] = useState(false);
    const [reauthError, setReauthError] = useState<Error | null>(null);

    const connection = recordings.data?.connection;
    const items = recordings.data?.items || [];
    const loading = recordings.isLoading || recordings.isFetching;

    const handleImport = async (item: TeamsRecordingItem) => {
        clearError();
        setBusyKey(item.eventId);
        try {
            const outcome = (await importFromTeams(item, { language: settings.language, contextTerms: settings.contextTerms })) as ImportOutcome;
            if (outcome?.ok) onComplete?.();
            else if (outcome?.pending) setPendingKeys((prev) => new Set(prev).add(item.eventId));
        } finally {
            setBusyKey(null);
        }
    };

    const handleReauthorize = async () => {
        setReauthBusy(true);
        setReauthError(null);
        try {
            const result = await openMicrosoftOAuthPopup({ authFetch, apiBase: API_BASE });
            if (result?.success) await invalidate();
        } catch (err) {
            setReauthError(err as Error);
        } finally {
            setReauthBusy(false);
        }
    };

    // Connected, but the grant predates the Teams permissions: every request
    // would fail, so explain and offer the reconnect instead of the list.
    if (connection && connection.microsoftConnected && !connection.teamsScopesGranted) {
        return (
            <div className={`flex flex-col items-center gap-3 px-4 py-10 text-center ${PANEL}`}>
                <div className={`w-12 h-12 rounded-2xl ${TEAMS_TILE}`}>
                    <Video className="w-6 h-6" />
                </div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('meetings.teams_reconsent_title', 'Microsoft Teams needs additional access')}
                </div>
                <div className="text-xs max-w-sm text-[var(--text-muted)]">
                    {t('meetings.teams_reconsent_desc', 'Your Microsoft 365 account was connected before Teams recordings were supported. Reconnect to let Bee Flow list and import the meetings you organise — your Outlook and OneDrive access keeps working. Your Microsoft 365 admin may need to approve the new permissions.')}
                </div>
                {reauthError && <div className="text-xs text-[var(--error)]">{reauthError.message}</div>}
                <button type="button" onClick={handleReauthorize} disabled={reauthBusy} className={PRIMARY_BTN}>
                    {reauthBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {t('meetings.teams_reauthorize', 'Reconnect Microsoft 365')}
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <CaptureControls />

            <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-[var(--text-muted)]">
                    {t('meetings.teams_pick', 'Pick a Teams meeting you organised — Bee Flow transcribes its recording with your configured engine.')}
                </div>
                <button
                    type="button"
                    onClick={() => recordings.refetch()}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 flex-shrink-0 border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('meetings.refresh', 'Refresh')}
                </button>
            </div>

            {recordings.isLoading && (
                <div className={`flex items-center gap-3 px-4 py-6 justify-center ${PANEL}`}>
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-secondary)]" />
                    <span className="text-sm text-[var(--text-secondary)]">{t('meetings.teams_loading', 'Loading Teams meetings…')}</span>
                </div>
            )}

            {!recordings.isLoading && recordings.error && (
                <div className={ERROR_BOX}>
                    <div className="font-semibold">{t('meetings.talk_load_failed', 'Couldn’t load recordings')}</div>
                    <div className="text-[var(--text-secondary)]">{recordings.error.message}</div>
                </div>
            )}

            {!recordings.isLoading && !recordings.error && items.length === 0 && (
                <div className={`flex flex-col items-center gap-2 px-4 py-10 text-center ${PANEL}`}>
                    <div className={`w-12 h-12 rounded-2xl ${TEAMS_TILE}`}>
                        <Video className="w-6 h-6" />
                    </div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{t('meetings.teams_empty_title', 'No Teams meetings found')}</div>
                    <div className="text-xs max-w-sm text-[var(--text-muted)]">
                        {t('meetings.teams_empty_desc', 'Meetings you organised in Teams in the last week appear here. Start the recording in Teams (or let Bee Flow switch on automatic recording) — the recording is ready a few minutes after the meeting ends.')}
                    </div>
                </div>
            )}

            {!recordings.isLoading && !recordings.error && items.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-[48vh] overflow-y-auto pr-1">
                    {items.map((item) => {
                        const busy = uploading && busyKey === item.eventId;
                        const importable = item.recordingState === 'available' || item.recordingState === 'transcript_only';
                        return (
                            <div key={item.eventId} className={`flex items-center gap-3 px-3 py-2.5 ${PANEL}`}>
                                <div className={`w-9 h-9 rounded-lg flex-shrink-0 ${TEAMS_TILE}`}>
                                    <Video className="w-4 h-4" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate text-[var(--text-primary)]">{item.title || t('meetings.teams_call', 'Teams meeting')}</div>
                                    <div className="text-xs text-[var(--text-muted)]">
                                        {[fmtDate(item.start), fmtDuration(item.start, item.end),
                                            item.recordingState === 'transcript_only' ? t('meetings.teams_transcript_only', 'transcript only, no audio') : '']
                                            .filter(Boolean).join(' · ')}
                                    </div>
                                </div>
                                {item.importedNoteId ? (
                                    <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0 bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]">
                                        <Check className="w-3.5 h-3.5" /> {t('meetings.upcoming_note_created', 'Note created')}
                                    </span>
                                ) : pendingKeys.has(item.eventId) ? (
                                    <span className="flex items-center gap-1 text-xs flex-shrink-0 text-[var(--text-muted)]"
                                        title={t('meetings.teams_pending_hint', 'Teams is still processing this meeting. Bee Flow keeps checking and creates the note when it is ready.')}>
                                        <Clock className="w-3.5 h-3.5" /> {t('meetings.teams_pending', 'Waiting for Teams')}
                                    </span>
                                ) : importable ? (
                                    <button type="button" onClick={() => handleImport(item)} disabled={uploading} className={`${PRIMARY_BTN} flex-shrink-0`}>
                                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                        {busy ? t('meetings.transcribing', 'Transcribing…') : t('meetings.transcribe', 'Transcribe')}
                                    </button>
                                ) : (
                                    <span className="text-xs flex-shrink-0 text-[var(--text-muted)]">{t('meetings.gmeet_no_recording', 'No recording')}</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {(uploading || uploadStage) && (
                <div className={`flex items-center gap-3 px-4 py-3 ${PANEL}`}>
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-secondary)]" />
                    <span className="text-sm text-[var(--text-secondary)]">{uploadStage || t('meetings.upload_working', 'Working…')}</span>
                </div>
            )}

            {uploadError && (
                <div className={ERROR_BOX}>
                    <div className="font-semibold">{t('meetings.import_failed', 'Import failed')}</div>
                    <div className="text-[var(--text-secondary)]">{uploadError.message}</div>
                    <button
                        type="button"
                        onClick={clearError}
                        className="self-start px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('meetings.dismiss', 'Dismiss')}
                    </button>
                </div>
            )}
        </div>
    );
}
