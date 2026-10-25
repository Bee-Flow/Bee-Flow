import React, { useState } from 'react';
import { MessageSquare, Loader2 } from 'lucide-react';
import { API_BASE } from '../../utils/helpers';
import { useOrgNotesSettingsQuery } from '../../api/queries/meetingNotesSettings';
import { NC_BLUE, LANGS, Toggle, Row, Select } from '../../pages/settings/shared/settingsPrimitives';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { mutate, errorBody, RefusedError } from '../../api/mutate';

interface MeetingNotesAdminPanelProps {
    user?: { organizationId?: string } | null;
}

interface TalkNotesConfig {
    autoTranscribe: boolean;
    postSummaryBack: boolean;
    recordingFolder: string;
    language: string;
    autoRecord: boolean;
    autoRecordScope: string;
    recordingMode: string;
    insightsPerPersonStats: boolean;
}

interface SaveMessage {
    type: 'success' | 'error';
    text: string | undefined;
}

const DEFAULT_CFG: TalkNotesConfig = { autoTranscribe: false, postSummaryBack: false, recordingFolder: '/Talk/Recording', language: 'nl', autoRecord: false, autoRecordScope: 'calendar', recordingMode: 'audio', insightsPerPersonStats: true };

/**
 * Org-level Nextcloud Talk → Meeting Notes settings. Mirrors the privacy-shield
 * admin pattern. Org values take precedence over each member's own settings.
 */
export default function MeetingNotesAdminPanel({ user }: MeetingNotesAdminPanelProps) {
    const { t } = useTranslation();
    const orgId = user?.organizationId;
    // recordingFolder: Talk saves to <attachment folder>/Recording/<room token>/,
    // so /Talk/Recording is the default on a stock Nextcloud.
    const settingsQuery = useOrgNotesSettingsQuery<TalkNotesConfig>('talk', orgId);
    const [draft, setDraft] = useState<TalkNotesConfig | null>(null);
    // Edits replace the whole config (defaults, then the server answer, then the person's changes).
    const cfg: TalkNotesConfig = draft ?? { ...DEFAULT_CFG, ...settingsQuery.data };
    const setCfg = (update: (c: TalkNotesConfig) => TalkNotesConfig) => setDraft(update(cfg));
    const loading = !!orgId && settingsQuery.isPending;
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<SaveMessage | null>(null);

    const save = async () => {
        setSaving(true); setMessage(null);
        try {
            let res: Response | undefined;
            try {
                res = await mutate(`${API_BASE}/api/talk-notes-settings/${orgId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                setMessage({ type: 'error', text: e.error || `HTTP ${err.status}` });
            }
            if (res) setMessage({ type: 'success', text: t('common.saved', 'Saved') });
        } catch (e) { setMessage({ type: 'error', text: errorMessage(e) }); }
        finally { setSaving(false); }
    };

    if (!orgId) return null;

    return (
        <div className="mt-6">
            <div className="flex items-center gap-2 mb-2">
                <MessageSquare className="w-4 h-4" style={{ color: NC_BLUE }} />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('meetings.admin_talk.title', 'Talk Meeting Notes')}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('meetings.admin_talk.intro', 'Turn Nextcloud Talk call recordings into Meeting Notes, transcribed by your organisation\'s configured transcription engine. These org settings override each member\'s personal settings.')}
            </p>

            {loading ? (
                <div className="flex items-center gap-2 px-5 py-4 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                    <span className="text-[13px] text-[var(--text-muted)]">{t('common.loading_ellipsis', 'Loading…')}</span>
                </div>
            ) : (
                <>
                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        <Row title={t('meetings.admin_talk.auto_record', 'Auto-record Talk meetings')} desc={t('meetings.admin_talk.auto_record_desc', 'Automatically start recording calls members moderate (requires the Nextcloud recording backend).')}>
                            <Toggle ariaLabel={t('meetings.admin_talk.auto_record', 'Auto-record Talk meetings')} on={cfg.autoRecord} onClick={() => setCfg((c: TalkNotesConfig) => ({ ...c, autoRecord: !c.autoRecord }))} disabled={saving} />
                        </Row>
                        {cfg.autoRecord && (
                            <>
                                <Row title={t('meetings.admin_talk.which', 'Which calls')} desc={t('meetings.admin_talk.which_desc', 'Record only scheduled calendar meetings, or every call a member moderates.')}>
                                    <Select ariaLabel={t('meetings.admin_talk.which', 'Which calls')} value={cfg.autoRecordScope} disabled={saving} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCfg((c: TalkNotesConfig) => ({ ...c, autoRecordScope: e.target.value }))}
                                        options={[{ value: 'calendar', label: t('meetings.admin_talk.scope_calendar', 'Calendar meetings') }, { value: 'all', label: t('meetings.admin_talk.scope_all', 'Any moderated call') }]} />
                                </Row>
                                <Row title={t('meetings.admin_talk.quality', 'Recording quality')} desc={t('meetings.admin_talk.quality_desc', 'Audio-only is smaller and faster to transcribe.')}>
                                    <Select ariaLabel={t('meetings.admin_talk.quality', 'Recording quality')} value={cfg.recordingMode} disabled={saving} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCfg((c: TalkNotesConfig) => ({ ...c, recordingMode: e.target.value }))}
                                        options={[{ value: 'audio', label: t('meetings.admin_talk.audio_only', 'Audio-only') }, { value: 'video', label: t('meetings.admin_talk.video', 'Video') }]} />
                                </Row>
                            </>
                        )}
                        <Row title={t('meetings.admin_talk.auto_transcribe', 'Auto-transcribe Talk recordings')} desc={t('meetings.admin_talk.auto_transcribe_desc', 'When a new Talk recording appears, create a Meeting Note automatically.')}>
                            <Toggle ariaLabel={t('meetings.admin_talk.auto_transcribe', 'Auto-transcribe Talk recordings')} on={cfg.autoTranscribe} onClick={() => setCfg((c: TalkNotesConfig) => ({ ...c, autoTranscribe: !c.autoTranscribe }))} disabled={saving} />
                        </Row>
                        <Row title={t('meetings.admin_talk.post_summary', 'Post summary back into Talk')} desc={t('meetings.admin_talk.post_summary_desc', 'After transcription, post the summary + action items into the conversation.')}>
                            <Toggle ariaLabel={t('meetings.admin_talk.post_summary', 'Post summary back into Talk')} on={cfg.postSummaryBack} onClick={() => setCfg((c: TalkNotesConfig) => ({ ...c, postSummaryBack: !c.postSummaryBack }))} disabled={saving} />
                        </Row>
                        <Row title={t('meetings.admin_talk.folder', 'Recordings folder')} desc={t('meetings.admin_talk.folder_desc', 'Nextcloud Files folder where Talk saves recordings — normally /Talk/Recording, with one subfolder per conversation.')}>
                            <input
                                aria-label={t('meetings.admin_talk.folder', 'Recordings folder')}
                                type="text" value={cfg.recordingFolder}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCfg((c: TalkNotesConfig) => ({ ...c, recordingFolder: e.target.value }))}
                                disabled={saving} placeholder="/Talk/Recording"
                                className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                            />
                        </Row>
                        <Row title={t('meetings.admin_talk.insights', 'Per-person meeting insights')} desc={t('meetings.admin_talk.insights_desc', 'Show per-person statistics (talk time, longest monologue) on the meeting Insights panel. Off = members see only meeting-level metrics.')}>
                            <Toggle ariaLabel={t('meetings.admin_talk.insights', 'Per-person meeting insights')} on={cfg.insightsPerPersonStats !== false} onClick={() => setCfg((c: TalkNotesConfig) => ({ ...c, insightsPerPersonStats: c.insightsPerPersonStats === false }))} disabled={saving} />
                        </Row>
                        <Row title={t('meetings.admin_talk.language', 'Default language')} desc={t('meetings.admin_talk.language_desc', 'Language used when auto-transcribing Talk recordings.')}>
                            <select
                                aria-label={t('meetings.admin_talk.language', 'Default language')}
                                value={cfg.language} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCfg((c: TalkNotesConfig) => ({ ...c, language: e.target.value }))} disabled={saving}
                                className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                            >
                                {LANGS.map((l: { code: string; label: string }) => <option key={l.code} value={l.code}>{l.label}</option>)}
                            </select>
                        </Row>
                    </div>

                    <div className="flex items-center gap-3 mt-3">
                        <button
                            onClick={save} disabled={saving}
                            className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        >
                            {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                        </button>
                        {message && (
                            <span className={`text-[12px] font-medium ${message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`}>
                                {message.type === 'success' ? '✓' : '⚠'} {message.text}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
