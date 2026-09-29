import React, { useEffect, useRef } from 'react';
import { Mic, Square, Pause, Play, X, Loader2 } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import CaptureControls from './CaptureControls';
import { useRecorder } from '../hooks/RecorderContext';
import { formatDuration } from '../lib/format';

/**
 * Live recording. Every colour is a theme token — the recording ring and the
 * mic button used to carry the brand yellow and a rose hex, which the
 * repo-wide colour hygiene rule forbids: `--accent-primary` is that yellow in
 * the light theme and stays right in the dark one.
 */
export default function RecordPanel({ onComplete }) {
    const { t } = useTranslation();
    const { recorder, uploading, uploadError, clearError, retryWithProvider, canRetry } = useRecorder();
    const { state, elapsed, level, error, start, stop, pause, resume, cancel } = recorder;

    // Auto-close only after a successful upload completes: track when
    // `uploading` flipped to true at least once, then close on the
    // true → false transition if there's no error to show.
    const wasUploading = useRef(false);
    useEffect(() => {
        if (uploading) {
            wasUploading.current = true;
            return;
        }
        if (wasUploading.current && !uploadError) {
            wasUploading.current = false;
            onComplete?.();
        }
    }, [uploading, uploadError, onComplete]);

    const recording = state === 'recording' || state === 'paused';
    const ringScale = 1 + Math.min(0.6, level * 1.2);

    return (
        <div className="flex flex-col items-center gap-6 py-2">
            <CaptureControls />

            <div className="relative flex items-center justify-center" style={{ height: 220 }}>
                {recording && (
                    <span
                        aria-hidden
                        className="absolute rounded-full transition-transform"
                        style={{
                            width: 180,
                            height: 180,
                            background: 'radial-gradient(circle, color-mix(in srgb, var(--accent-primary) 25%, transparent) 0%, transparent 70%)',
                            transform: `scale(${ringScale})`,
                        }}
                    />
                )}
                <button
                    type="button"
                    onClick={() => {
                        if (state === 'idle') start();
                        else stop();
                    }}
                    aria-label={state === 'idle' ? t('meetings.record_start', 'Start recording') : t('meetings.record_stop', 'Stop recording')}
                    className="relative w-24 h-24 rounded-full flex items-center justify-center text-white shadow-xl transition-transform hover:scale-105 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                        background: recording ? 'var(--error)' : 'var(--accent-primary)',
                        // Recording keeps the class's white ink on the red fill;
                        // idle takes the accent's own foreground token.
                        color: recording ? undefined : 'var(--accent-primary-fg)',
                    }}
                    disabled={state === 'stopping' || uploading}
                >
                    {uploading
                        ? <Loader2 className="w-10 h-10 animate-spin" />
                        : recording
                            ? <Square className="w-10 h-10" fill="currentColor" />
                            : <Mic className="w-10 h-10" />}
                </button>
            </div>

            <div className="text-center">
                <div className="text-3xl font-mono font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    {formatDuration(elapsed)}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {state === 'recording' && t('meetings.record_in_progress', 'Recording in progress')}
                    {state === 'paused' && t('meetings.record_paused', 'Paused')}
                    {state === 'idle' && !uploading && t('meetings.record_hint', 'Tap the mic to start')}
                    {state === 'stopping' && t('meetings.record_processing', 'Processing audio…')}
                    {uploading && t('meetings.record_uploading', 'Transcribing your meeting…')}
                </div>
            </div>

            {recording && (
                <div className="flex items-center gap-2">
                    {state === 'recording' ? (
                        <button
                            type="button"
                            onClick={pause}
                            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm border"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        >
                            <Pause className="w-4 h-4" /> {t('meetings.record_pause', 'Pause')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={resume}
                            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm border"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        >
                            <Play className="w-4 h-4" /> {t('meetings.record_resume', 'Resume')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={cancel}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-sm border"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
                    >
                        <X className="w-4 h-4" /> {t('meetings.record_discard', 'Discard')}
                    </button>
                </div>
            )}

            {error && (
                <div className="text-xs max-w-sm text-center" style={{ color: 'var(--error)' }}>
                    {error.name === 'NotAllowedError'
                        ? t('meetings.record_mic_denied', 'Microphone access denied. Please allow access in your browser settings.')
                        : t('meetings.record_mic_error', 'Microphone error: {message}', { message: error.message || 'unknown' })}
                </div>
            )}

            {uploadError && (
                <div
                    className="w-full flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs"
                    style={{ background: 'color-mix(in srgb, var(--error) 8%, var(--bg-secondary))', borderColor: 'var(--error)', color: 'var(--text-primary)' }}
                >
                    <div className="font-semibold">{t('meetings.failed_title', 'Transcription failed')}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{uploadError.message}</div>
                    <div className="flex items-center gap-2">
                        {canRetry && (
                            <button
                                type="button"
                                onClick={() => retryWithProvider()}
                                disabled={uploading}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                                style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                            >
                                {t('meetings.retry', 'Retry')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={clearError}
                            disabled={uploading}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                            {t('meetings.dismiss', 'Dismiss')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
