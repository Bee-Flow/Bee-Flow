import React, { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { NC_BLUE, LANGS, Toggle, Row, Select } from './shared/settingsPrimitives';
import { useTranslation } from '../../hooks/useTranslation';

interface TalkNotesConfig {
    autoTranscribe: boolean;
    postSummaryBack: boolean;
    recordingFolder: string;
    language: string;
    autoRecord: boolean;
    autoRecordScope: string;
    recordingMode: string;
}

interface SaveMessage {
    type: 'success' | 'error';
    text: string;
}

/**
 * Personal Nextcloud Talk → Meeting Notes settings. Rendered for every account
 * that has the Meeting Notes feature; self-hides (renders null) when the
 * feature isn't licensed (the API returns a non-OK status). Org-level settings,
 * when present, take precedence over these per field.
 */
export default function MeetingNotesSection() {
    const { t } = useTranslation();
    // recordingFolder: Talk saves to <attachment folder>/Recording/<room token>/,
    // so /Talk/Recording is the default on a stock Nextcloud.
    const [cfg, setCfg] = useState<TalkNotesConfig>({ autoTranscribe: false, postSummaryBack: false, recordingFolder: '/Talk/Recording', language: 'nl', autoRecord: false, autoRecordScope: 'calendar', recordingMode: 'audio' });
    const [available, setAvailable] = useState(true);
    const [connected, setConnected] = useState(false);
    const [recordingEnabled, setRecordingEnabled] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<SaveMessage | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/talk-notes-settings/user/me`);
                if (res.ok) {
                    const data = await res.json();
                    setConnected(!!data.nextcloudConnected);
                    setRecordingEnabled(!!data.recordingEnabled);
                    setCfg((prev: TalkNotesConfig) => ({ ...prev, ...data }));
                } else setAvailable(false); // 403/404 → feature not licensed for this account
            } catch (_) { setAvailable(false); } finally { setLoading(false); }
        })();
    }, []);

    const save = async () => {
        setSaving(true); setMessage(null);
        try {
            const res = await authFetch(`${API_BASE}/api/talk-notes-settings/user/me`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
            });
            if (res.ok) setMessage({ type: 'success', text: t('settings.talk_notes.saved', "Saved") });
            else { const e = await res.json().catch(() => ({})); setMessage({ type: 'error', text: e.error || `HTTP ${res.status}` }); }
        } catch (e) { setMessage({ type: 'error', text: (e as Error).message }); }
        finally { setSaving(false); }
    };

    // Render nothing until we know — avoids flashing the section for accounts
    // that turn out to lack the feature or a Nextcloud connection.
    if (loading) return null;
    if (!available || !connected) return null;

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <MessageSquare className="w-4 h-4" style={{ color: NC_BLUE }} />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('settings.talk_notes.title', "Nextcloud Talk Meeting Notes")}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('settings.talk_notes.intro', "Bring your Nextcloud Talk call recordings into Meeting Notes, transcribed by your configured engine. Your organisation's settings, where set, take precedence.")}
            </p>

            <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                <Row title={t('settings.talk_notes.auto_record_title', "Auto-record my Talk meetings")} desc={recordingEnabled ? t('settings.talk_notes.auto_record_desc', "Automatically start recording calls you moderate, then transcribe them.") : t('settings.talk_notes.auto_record_unavailable', "Unavailable — the Nextcloud recording backend is not configured.")}>
                    <Toggle on={cfg.autoRecord && recordingEnabled} onClick={() => setCfg(c => ({ ...c, autoRecord: !c.autoRecord }))} disabled={saving || !recordingEnabled} ariaLabel={t('settings.talk_notes.auto_record_title', "Auto-record my Talk meetings")} />
                </Row>
                {cfg.autoRecord && recordingEnabled && (
                    <>
                        <Row title={t('settings.talk_notes.scope_title', "Which calls")} desc={t('settings.talk_notes.scope_desc', "Record only scheduled calendar meetings, or every call you moderate.")}>
                            <Select value={cfg.autoRecordScope} disabled={saving} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCfg(c => ({ ...c, autoRecordScope: e.target.value }))}
                                ariaLabel={t('settings.talk_notes.scope_title', "Which calls")}
                                options={[{ value: 'calendar', label: t('settings.talk_notes.scope_calendar', "Calendar meetings") }, { value: 'all', label: t('settings.talk_notes.scope_all', "Any call I moderate") }]} />
                        </Row>
                        <Row title={t('settings.talk_notes.quality_title', "Recording quality")} desc={t('settings.talk_notes.quality_desc', "Audio-only is smaller and faster to transcribe.")}>
                            <Select value={cfg.recordingMode} disabled={saving} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCfg(c => ({ ...c, recordingMode: e.target.value }))}
                                ariaLabel={t('settings.talk_notes.quality_title', "Recording quality")}
                                options={[{ value: 'audio', label: t('settings.talk_notes.quality_audio', "Audio-only") }, { value: 'video', label: t('settings.talk_notes.quality_video', "Video") }]} />
                        </Row>
                    </>
                )}
                <Row title={t('settings.talk_notes.transcribe_title', "Auto-transcribe my Talk recordings")} desc={t('settings.talk_notes.transcribe_desc', "When a new Talk recording appears, create a Meeting Note automatically.")}>
                    <Toggle on={cfg.autoTranscribe} onClick={() => setCfg(c => ({ ...c, autoTranscribe: !c.autoTranscribe }))} disabled={saving} ariaLabel={t('settings.talk_notes.transcribe_title', "Auto-transcribe my Talk recordings")} />
                </Row>
                <Row title={t('settings.talk_notes.post_summary_title', "Post summary back into Talk")} desc={t('settings.talk_notes.post_summary_desc', "After transcription, post the summary + action items into the conversation.")}>
                    <Toggle on={cfg.postSummaryBack} onClick={() => setCfg(c => ({ ...c, postSummaryBack: !c.postSummaryBack }))} disabled={saving} ariaLabel={t('settings.talk_notes.post_summary_title', "Post summary back into Talk")} />
                </Row>
                <Row title={t('settings.talk_notes.folder_title', "Recordings folder")} desc={t('settings.talk_notes.folder_desc', "Nextcloud Files folder where Talk saves your recordings — normally /Talk/Recording, with one subfolder per conversation.")}>
                    <input
                        type="text" value={cfg.recordingFolder}
                        onChange={e => setCfg(c => ({ ...c, recordingFolder: e.target.value }))}
                        disabled={saving} placeholder="/Talk/Recording"
                        aria-label={t('settings.talk_notes.folder_title', "Recordings folder")}
                        className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                    />
                </Row>
                <Row title={t('settings.talk_notes.language_title', "Default language")} desc={t('settings.talk_notes.language_desc', "Language used when auto-transcribing your Talk recordings.")}>
                    <select
                        value={cfg.language} onChange={e => setCfg(c => ({ ...c, language: e.target.value }))} disabled={saving}
                        aria-label={t('settings.talk_notes.language_title', "Default language")}
                        className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                    >
                        {LANGS.map((l: { code: string; label: string }) => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                </Row>
            </div>

            <div className="flex items-center gap-3 mt-3">
                <button
                    type="button" onClick={save} disabled={saving}
                    className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                >
                    {saving ? t('settings.talk_notes.saving', "Saving…") : t('settings.talk_notes.save', "Save")}
                </button>
                {message && (
                    <span className={`text-[12px] font-medium ${message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error)]'}`}>
                        {message.type === 'success' ? '✓' : '⚠'} {message.text}
                    </span>
                )}
            </div>
        </div>
    );
}
