import React, { useRef, useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import CaptureControls from './CaptureControls';
import { useRecorder } from '../hooks/RecorderContext';
import { errorMessage, errorCode as caughtErrorCode } from '../../../utils/caughtError';

export default function UploadPanel({ onComplete }: { onComplete?: () => void }) {
    const { t } = useTranslation();
    const { uploadFile, retryWithProvider, canRetry, setSettings, uploading, uploadStage, uploadError, clearError } = useRecorder();
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragOver, setDragOver] = useState(false);

    const handleFiles = async (files: FileList | null | undefined) => {
        const file = files?.[0];
        if (!file) return;
        clearError();
        const outcome = await uploadFile(file);
        if (outcome?.ok) onComplete?.();
    };

    const handleSwitchEngineRetry = async () => {
        // Switch the default engine to voxtral and re-upload the cached file.
        setSettings((s) => ({ ...s, provider: 'voxtral' }));
        const outcome = await retryWithProvider('voxtral');
        if (outcome?.ok) onComplete?.();
    };

    const errorCode = caughtErrorCode(uploadError) || null;
    const isTooLongNoFallback = errorCode === 'local_whisper_too_long_no_fallback';

    return (
        <div className="flex flex-col gap-4">
            <CaptureControls />

            <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
                onClick={() => inputRef.current?.click()}
                className="relative flex flex-col items-center justify-center gap-3 px-6 py-12 rounded-2xl border-2 border-dashed cursor-pointer transition-colors"
                style={{
                    background: dragOver ? 'color-mix(in srgb, var(--accent-primary) 8%, var(--bg-secondary))' : 'var(--bg-secondary)',
                    borderColor: dragOver ? 'var(--accent-primary)' : 'var(--border-default)',
                }}
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept="audio/*,video/*"
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                />
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center [background:color-mix(in_srgb,var(--accent-primary)_12%,transparent)] [color:var(--accent-primary)]">
                    <Upload className="w-7 h-7" />
                </div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('meetings.upload_drop', 'Drop an audio file here, or click to browse')}
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                    {t('meetings.upload_formats', 'Supports .mp3, .wav, .m4a, .webm, .mp4 — up to ~2 hours')}
                </div>
            </div>

            {(uploading || uploadStage) && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                    <span className="text-sm text-[var(--text-secondary)]">{uploadStage || t('meetings.upload_working', 'Working…')}</span>
                </div>
            )}
            {Boolean(uploadError) && isTooLongNoFallback && (
                <div
                    className="flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs [background:color-mix(in_srgb,var(--warning)_8%,var(--bg-secondary))] [border-color:var(--warning)] [color:var(--text-primary)]!"
                >
                    <div className="font-semibold">{t('meetings.upload_too_long_title', 'Recording too long for on-device transcription')}</div>
                    <div className="text-[var(--text-secondary)]">{errorMessage(uploadError)}</div>
                    {canRetry && (
                        <button
                            type="button"
                            onClick={handleSwitchEngineRetry}
                            disabled={uploading}
                            className="self-start px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 transition-opacity hover:opacity-90 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        >
                            {t('meetings.upload_switch_engine', 'Switch engine & retry')}
                        </button>
                    )}
                </div>
            )}
            {Boolean(uploadError) && !isTooLongNoFallback && (
                <div
                    className="flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs [background:color-mix(in_srgb,var(--error)_8%,var(--bg-secondary))] [border-color:var(--error)] [color:var(--text-primary)]!"
                >
                    <div className="font-semibold">{t('meetings.upload_failed', 'Upload failed')}</div>
                    <div className="text-[var(--text-secondary)]">{errorMessage(uploadError)}</div>
                    <div className="flex items-center gap-2">
                        {canRetry && (
                            <button
                                type="button"
                                onClick={async () => { const outcome = await retryWithProvider(); if (outcome?.ok) onComplete?.(); }}
                                disabled={uploading}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                            >
                                {t('meetings.retry', 'Retry')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={clearError}
                            disabled={uploading}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)]"
                        >
                            {t('meetings.dismiss', 'Dismiss')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
