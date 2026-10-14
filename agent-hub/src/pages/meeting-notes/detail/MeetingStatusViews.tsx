import { AlertTriangle, Loader2, X } from 'lucide-react';
import { PRIMARY_ACTION_STYLE } from '../../../components/shared/StudioSectionHeader';
import type { TranslateFn } from '../../../hooks/useTranslation';
import type { ApiError } from './meetingDetailTypes';

/** Placeholder while the first load of a note is in flight. */
export function DetailSkeleton({ t }: { t: TranslateFn }) {
    const bar = (w: number | string, h = 12) => (
        <div
            className="rounded-md animate-pulse"
            style={{ background: 'var(--bg-tertiary)', width: w, height: h }}
        />
    );
    return (
        <div className="h-full flex flex-col gap-4 px-4 sm:px-6 py-4" aria-busy="true" aria-label={t('meetings.loading_meeting', 'Loading meeting')}>
            <div className="flex items-start gap-3">
                <div className="flex-1 flex flex-col gap-2">
                    {bar('60%', 22)}
                    <div className="flex gap-2">
                        {bar(60)} {bar(80)} {bar(50)}
                    </div>
                </div>
                {bar(80, 28)}
            </div>
            {bar('100%', 64)}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                    {bar('90%')} {bar('80%')} {bar('95%')} {bar('70%')} {bar('85%')}
                </div>
                <div className="flex flex-col gap-2">
                    {bar('60%', 14)} {bar('100%')} {bar('100%')} {bar('80%')}
                </div>
            </div>
        </div>
    );
}

/**
 * A failed load must SAY so. Without it a 5xx on this note left the
 * previously-opened note rendered while the library highlighted this one —
 * and every action here (rename, delete, action items) targeted the stale
 * note. Deleting from that state destroyed a different meeting.
 */
export function MeetingLoadError({ t, error, onRetry }: { t: TranslateFn; error: ApiError; onRetry: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" role="alert">
            <AlertTriangle className="w-8 h-8" style={{ color: 'var(--error)' }} aria-hidden="true" />
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('meetings.load_failed', 'Couldn’t load this meeting')}
            </p>
            <p className="text-xs max-w-sm" style={{ color: 'var(--text-tertiary)' }}>
                {error.status === 404
                    ? t('meetings.load_failed_404', 'It may have been deleted, or you no longer have access to it.')
                    : (error.message || t('meetings.something_wrong', 'Something went wrong.'))}
            </p>
            {error.status !== 404 && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 px-4 py-2 rounded-lg text-sm font-medium"
                    style={PRIMARY_ACTION_STYLE}
                >
                    {t('meetings.try_again', 'Try again')}
                </button>
            )}
        </div>
    );
}

interface ProcessingBodyProps {
    t: TranslateFn;
    failed: boolean;
    reason: string;
    audioGone: boolean;
    canRetry: boolean;
    busy: boolean;
    onRetry: () => void;
}

/**
 * Async pipeline: a note is created in 'processing' and filled in when the
 * background transcription+diarization finishes. This is the status shown
 * instead of an empty player until it is 'completed', or the failure.
 */
export function MeetingProcessingBody({ t, failed, reason, audioGone, canRetry, busy, onRetry }: ProcessingBodyProps) {
    if (!failed) {
        return (
            <>
                <Loader2 className="w-10 h-10 animate-spin" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.transcribing_title', 'Transcribing…')}</p>
                <p className="text-sm max-w-md" style={{ color: 'var(--text-tertiary)' }}>
                    {t('meetings.transcribing_desc', 'This runs in the background — you can close this and come back. Long recordings with speaker labels can take a while on the local diarizer; the note updates automatically when it’s ready.')}
                </p>
            </>
        );
    }
    return (
        <>
            <AlertTriangle className="w-10 h-10" style={{ color: 'var(--error)' }} aria-hidden="true" />
            <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.failed_title', 'Transcription failed')}</p>
            {reason ? (
                <p className="text-sm max-w-md" style={{ color: 'var(--error)' }}>{reason}</p>
            ) : null}
            <p className="text-sm max-w-md" style={{ color: 'var(--text-tertiary)' }}>
                {audioGone
                    ? t('meetings.failed_audio_gone', 'The audio is no longer available, so this note cannot be retried.')
                    : t('meetings.failed_retry_hint', 'The recording is saved, so you can retry it.')}
            </p>
            {canRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    // Without this a double-click fired two runs against the
                    // same note, doubling the provider bill and letting the
                    // loser's error overwrite the winner's finished note.
                    disabled={busy || audioGone}
                    className="mt-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    style={PRIMARY_ACTION_STYLE}
                >
                    {busy ? t('meetings.starting', 'Starting…') : t('meetings.retry_transcription', 'Retry transcription')}
                </button>
            )}
        </>
    );
}

/** "Speakers updated. Regenerate the summary with the new names?" */
export function RegenerateOfferBanner({ t, regenerating, onRegenerate, onDismiss }: {
    t: TranslateFn;
    regenerating: boolean;
    onRegenerate: () => void;
    onDismiss: () => void;
}) {
    return (
        <div
            className="mx-4 sm:mx-6 mt-3 flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-xs"
            style={{ background: 'color-mix(in srgb, var(--accent-primary) 6%, var(--bg-secondary))', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
            role="status"
        >
            <span>{t('meeting_notes.regenerate_after_rename', 'Speakers updated. Regenerate the summary with the new names?')}</span>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onRegenerate}
                    disabled={regenerating}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold disabled:opacity-50"
                    style={PRIMARY_ACTION_STYLE}
                >
                    {regenerating ? t('meetings.regenerating', 'Regenerating…') : t('meeting_notes.regenerate', 'Regenerate')}
                </button>
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label={t('meetings.dismiss', 'Dismiss')}
                    className="p-1 rounded-md text-[var(--text-tertiary)]"
                >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}
