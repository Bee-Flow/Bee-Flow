import React, { useEffect, useState } from 'react';
import { MessageSquare, Loader2, FileAudio, Video, RefreshCw, Download } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import CaptureControls from './CaptureControls';
import { useRecorder } from '../hooks/RecorderContext';
import { listNextcloudTalkRecordings } from '../../../api/transcriptionsApi';
import { errorMessage } from '../../../utils/caughtError';

interface TalkRecording {
    path: string;
    name: string;
    kind: 'video' | 'audio';
    size: number | null;
    lastModified: string | null;
}

interface TalkRoom {
    token: string;
    name?: string;
    recordings: TalkRecording[];
}

/**
 * Talk keeps its blue, but as the THEME's blue — the same token the source
 * chip on a row uses (lib/sourceMeta.js), never the Nextcloud brand hex the
 * colour-hygiene rule rejects.
 */
const NC_BLUE = 'var(--type-ai)';

function fmtSize(bytes: number | null) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(s: string | null) {
    if (!s) return '';
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function TalkImportPanel({ onComplete }: { onComplete?: () => void }) {
    const { t } = useTranslation();
    const { uploadFromNextcloud, uploading, uploadStage, uploadError, clearError } = useRecorder();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<unknown>(null);
    const [rooms, setRooms] = useState<TalkRoom[]>([]);
    const [busyPath, setBusyPath] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await listNextcloudTalkRecordings();
            setRooms(Array.isArray(data?.rooms) ? data.rooms : []);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const handleImport = async (rec: TalkRecording) => {
        clearError();
        setBusyPath(rec.path);
        try {
            const outcome = await uploadFromNextcloud(rec);
            if (outcome?.ok) onComplete?.();
        } finally {
            setBusyPath(null);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <CaptureControls />

            <div className="flex items-center justify-between">
                <div className="text-xs text-[var(--text-muted)]">
                    {t('meetings.talk_pick', 'Pick a call recording — Bee Flow transcribes it with your configured engine.')}
                </div>
                <button
                    type="button"
                    onClick={load}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('meetings.refresh', 'Refresh')}
                </button>
            </div>

            {loading && (
                <div className="flex items-center gap-3 px-4 py-6 rounded-xl border justify-center bg-[var(--bg-secondary)] border-[var(--border-default)]">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: NC_BLUE }} />
                    <span className="text-sm text-[var(--text-secondary)]">{t('meetings.talk_loading', 'Loading Talk recordings…')}</span>
                </div>
            )}

            {!loading && Boolean(error) && (
                <div className="flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs [background:color-mix(in_srgb,var(--error)_8%,var(--bg-secondary))] [border-color:var(--error)] [color:var(--text-primary)]!">
                    <div className="font-semibold">{t('meetings.talk_load_failed', 'Couldn’t load recordings')}</div>
                    <div className="text-[var(--text-secondary)]">{errorMessage(error)}</div>
                </div>
            )}

            {!loading && !error && rooms.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-4 py-10 rounded-xl border text-center bg-[var(--bg-secondary)] border-[var(--border-default)]">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: `color-mix(in srgb, ${NC_BLUE} 12%, transparent)`, color: NC_BLUE }}>
                        <MessageSquare className="w-6 h-6" />
                    </div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{t('meetings.talk_empty_title', 'No Talk recordings found')}</div>
                    <div className="text-xs max-w-sm text-[var(--text-muted)]">
                        {t('meetings.talk_empty_desc', 'Record a call in Nextcloud Talk (the moderator can record audio-only or video). Finished recordings appear here automatically.')}
                    </div>
                </div>
            )}

            {!loading && !error && rooms.length > 0 && (
                <div className="flex flex-col gap-4 max-h-[48vh] overflow-y-auto pr-1">
                    {rooms.map((room) => (
                        <div key={room.token} className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 px-1">
                                <MessageSquare className="w-3.5 h-3.5" style={{ color: NC_BLUE }} />
                                <span className="text-xs font-semibold text-[var(--text-secondary)]">
                                    {room.name || t('meetings.talk_conversation', 'Conversation {token}', { token: room.token })}
                                </span>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                {room.recordings.map((rec) => {
                                    const busy = uploading && busyPath === rec.path;
                                    const KindIcon = rec.kind === 'video' ? Video : FileAudio;
                                    return (
                                        <div
                                            key={rec.path}
                                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]"
                                        >
                                            <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `color-mix(in srgb, ${NC_BLUE} 12%, transparent)`, color: NC_BLUE }}>
                                                <KindIcon className="w-4.5 h-4.5" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium truncate text-[var(--text-primary)]">{rec.name}</div>
                                                <div className="text-xs text-[var(--text-muted)]">
                                                    {[rec.kind === 'video' ? t('meetings.kind_video', 'Video') : t('meetings.kind_audio', 'Audio'), fmtSize(rec.size), fmtDate(rec.lastModified)].filter(Boolean).join(' · ')}
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleImport(rec)}
                                                disabled={uploading}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 flex-shrink-0 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                                            >
                                                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                                {busy ? t('meetings.transcribing', 'Transcribing…') : t('meetings.transcribe', 'Transcribe')}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {(uploading || uploadStage) && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: NC_BLUE }} />
                    <span className="text-sm text-[var(--text-secondary)]">{uploadStage || t('meetings.upload_working', 'Working…')}</span>
                </div>
            )}

            {Boolean(uploadError) && (
                <div className="flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs [background:color-mix(in_srgb,var(--error)_8%,var(--bg-secondary))] [border-color:var(--error)] [color:var(--text-primary)]!">
                    <div className="font-semibold">{t('meetings.import_failed', 'Import failed')}</div>
                    <div className="text-[var(--text-secondary)]">{errorMessage(uploadError)}</div>
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
