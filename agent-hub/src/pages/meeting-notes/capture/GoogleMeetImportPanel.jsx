import React, { useEffect, useState } from 'react';
import { Video, Loader2, RefreshCw, Download, Check } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import CaptureControls from './CaptureControls';
import { useRecorder } from '../hooks/RecorderContext';
import useGoogleMeetConnected from '../hooks/useGoogleMeetConnected';
import { listGoogleMeetRecordings } from '../lib/transcriptionsApi';
import { openGoogleOAuthPopup } from '../../../lib/googleOAuthPopup';
import { API_BASE, authFetch } from '../../../utils/helpers';

/**
 * Meet keeps its green, but as the THEME's green — the token the source chip
 * on a row already uses (lib/sourceMeta.js) instead of the Google brand hex.
 */
const MEET_GREEN = 'var(--success)';

function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function fmtDuration(start, end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (isNaN(s) || isNaN(e) || e <= s) return '';
    const mins = Math.round((e - s) / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

export default function GoogleMeetImportPanel({ onComplete }) {
    const { t } = useTranslation();
    const { importFromGoogleMeet, settings, uploading, uploadStage, uploadError, clearError } = useRecorder();
    const { needsReconsent } = useGoogleMeetConnected(true);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [items, setItems] = useState([]);
    const [busyKey, setBusyKey] = useState(null);
    const [reauthorized, setReauthorized] = useState(false);
    const [reauthBusy, setReauthBusy] = useState(false);
    const [reauthError, setReauthError] = useState(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await listGoogleMeetRecordings();
            setItems(Array.isArray(data?.items) ? data.items : []);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const handleImport = async (item) => {
        clearError();
        setBusyKey(item.eventId || item.meetingCode);
        try {
            const outcome = await importFromGoogleMeet(item, { language: settings.language, contextTerms: settings.contextTerms });
            if (outcome?.ok) onComplete?.();
        } finally {
            setBusyKey(null);
        }
    };

    const handleReauthorize = async () => {
        setReauthBusy(true);
        setReauthError(null);
        try {
            const result = await openGoogleOAuthPopup({ authFetch, apiBase: API_BASE });
            if (result?.success) {
                setReauthorized(true);
                load();
            }
        } catch (err) {
            setReauthError(err);
        } finally {
            setReauthBusy(false);
        }
    };

    // Connected before the Meet scopes existed — every recordings request
    // would fail, so show the re-consent explainer instead of the list until
    // the popup succeeds.
    if (needsReconsent && !reauthorized) {
        return (
            <div className="flex flex-col items-center gap-3 px-4 py-10 rounded-xl border text-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: `color-mix(in srgb, ${MEET_GREEN} 12%, transparent)`, color: MEET_GREEN }}>
                    <Video className="w-6 h-6" />
                </div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.gmeet_reconsent_title', 'Google Meet needs additional access')}</div>
                <div className="text-xs max-w-sm" style={{ color: 'var(--text-muted)' }}>
                    {t('meetings.gmeet_reconsent_desc', 'Your Google account was connected before Meet recordings were supported. Re-authorize to let Bee Flow list and import your Meet recordings — your other Google integrations keep working.')}
                </div>
                {reauthError && (
                    <div className="text-xs" style={{ color: 'var(--error)' }}>{reauthError.message}</div>
                )}
                <button
                    type="button"
                    onClick={handleReauthorize}
                    disabled={reauthBusy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                >
                    {reauthBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {t('meetings.gmeet_reauthorize', 'Re-authorize Google')}
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <CaptureControls />

            <div className="flex items-center justify-between">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('meetings.gmeet_pick', 'Pick a recorded Meet call — Bee Flow transcribes it with your configured engine.')}
                </div>
                <button
                    type="button"
                    onClick={load}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('meetings.refresh', 'Refresh')}
                </button>
            </div>

            {loading && (
                <div className="flex items-center gap-3 px-4 py-6 rounded-xl border justify-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: MEET_GREEN }} />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('meetings.gmeet_loading', 'Loading Meet recordings…')}</span>
                </div>
            )}

            {!loading && error && (
                <div className="flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs" style={{ background: 'color-mix(in srgb, var(--error) 8%, var(--bg-secondary))', borderColor: 'var(--error)', color: 'var(--text-primary)' }}>
                    <div className="font-semibold">{t('meetings.talk_load_failed', 'Couldn’t load recordings')}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{error.message}</div>
                </div>
            )}

            {!loading && !error && items.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-4 py-10 rounded-xl border text-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: `color-mix(in srgb, ${MEET_GREEN} 12%, transparent)`, color: MEET_GREEN }}>
                        <Video className="w-6 h-6" />
                    </div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.gmeet_empty_title', 'No Meet recordings found')}</div>
                    <div className="text-xs max-w-sm" style={{ color: 'var(--text-muted)' }}>
                        {t('meetings.gmeet_empty_desc', 'Record a meeting in Google Meet (the host starts the recording). Finished recordings appear here shortly after the meeting ends.')}
                    </div>
                </div>
            )}

            {!loading && !error && items.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-[48vh] overflow-y-auto pr-1">
                    {items.map((item) => {
                        const key = item.eventId || item.meetingCode;
                        const busy = uploading && busyKey === key;
                        return (
                            <div
                                key={key}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-xl border"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
                            >
                                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `color-mix(in srgb, ${MEET_GREEN} 12%, transparent)`, color: MEET_GREEN }}>
                                    <Video className="w-4.5 h-4.5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.title || t('meetings.gmeet_call', 'Meet call')}</div>
                                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {[fmtDate(item.start), fmtDuration(item.start, item.end)].filter(Boolean).join(' · ')}
                                    </div>
                                </div>
                                {item.importedNoteId ? (
                                    <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0" style={{ background: `color-mix(in srgb, ${MEET_GREEN} 14%, transparent)`, color: 'var(--success-ink)' }}>
                                        <Check className="w-3.5 h-3.5" /> {t('meetings.upcoming_note_created', 'Note created')}
                                    </span>
                                ) : item.recordingState === 'available' ? (
                                    <button
                                        type="button"
                                        onClick={() => handleImport(item)}
                                        disabled={uploading}
                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 flex-shrink-0"
                                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                                    >
                                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                        {busy ? t('meetings.transcribing', 'Transcribing…') : t('meetings.transcribe', 'Transcribe')}
                                    </button>
                                ) : item.recordingState === 'processing' ? (
                                    <button
                                        type="button"
                                        disabled
                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border opacity-60 flex-shrink-0"
                                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                                    >
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('meetings.gmeet_processing', 'Processing…')}
                                    </button>
                                ) : (
                                    <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{t('meetings.gmeet_no_recording', 'No recording')}</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {(uploading || uploadStage) && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: MEET_GREEN }} />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{uploadStage || t('meetings.upload_working', 'Working…')}</span>
                </div>
            )}

            {uploadError && (
                <div className="flex flex-col gap-2 px-3 py-3 rounded-xl border text-xs" style={{ background: 'color-mix(in srgb, var(--error) 8%, var(--bg-secondary))', borderColor: 'var(--error)', color: 'var(--text-primary)' }}>
                    <div className="font-semibold">{t('meetings.import_failed', 'Import failed')}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{uploadError.message}</div>
                    <button
                        type="button"
                        onClick={clearError}
                        className="self-start px-3 py-1.5 rounded-lg text-xs font-medium border"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                        {t('meetings.dismiss', 'Dismiss')}
                    </button>
                </div>
            )}
        </div>
    );
}
