import React, { useEffect, useState } from 'react';
import { Users, Loader2 } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { LANGS, Toggle, Row } from '../../pages/settings/shared/settingsPrimitives';
import {
    useTeamsNotesOrgSettings,
    useSaveTeamsNotesOrgSettings,
    type TeamsNotesSettings,
} from '../../api/queries/teamsMeetingNotes';

/**
 * Org-level Microsoft Teams → Meeting Notes settings, next to the Google Meet
 * panel. Org values take precedence over each member's own settings.
 *
 * What the admin needs to know is said here, not discovered later: the app
 * registration needs admin consent for the Teams permissions, and only the
 * organizer of a meeting can import it.
 */
export default function TeamsAdminPanel({ user }: { user?: { organizationId?: string | null } | null }) {
    const { t } = useTranslation();
    const orgId = user?.organizationId || null;
    const query = useTeamsNotesOrgSettings(orgId);
    const save = useSaveTeamsNotesOrgSettings(orgId);
    const [cfg, setCfg] = useState<TeamsNotesSettings>({ autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 });
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        if (query.data) setCfg((prev) => ({ ...prev, ...query.data }));
    }, [query.data]);

    if (!orgId) return null;
    const busy = save.isPending;

    const onSave = async () => {
        setMessage(null);
        try {
            await save.mutateAsync(cfg);
            setMessage({ type: 'success', text: t('settings.teams_notes_saved', 'Saved') });
        } catch (e) {
            setMessage({ type: 'error', text: (e as Error).message });
        }
    };

    return (
        <div className="mt-6">
            <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-[var(--accent-secondary)]" />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('settings.teams_notes_title', 'Microsoft Teams Meeting Notes')}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('settings.teams_admin_intro', 'Turn the Teams meetings members organise into Meeting Notes, transcribed by your organisation’s own transcription engine. Your Microsoft 365 admin must grant admin consent for the Teams meeting permissions (OnlineMeetingRecording.Read.All, OnlineMeetingTranscript.Read.All, OnlineMeetings.ReadWrite). These org settings override each member’s personal settings.')}
            </p>

            {query.isLoading ? (
                <div className="flex items-center gap-2 px-5 py-4 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-secondary)]" />
                    <span className="text-[13px] text-[var(--text-muted)]">{t('common.loading', 'Loading…')}</span>
                </div>
            ) : (
                <>
                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        <Row
                            title={t('settings.teams_admin_auto_import', 'Auto-import recorded Teams meetings')}
                            desc={t('settings.teams_admin_auto_import_desc', 'When a Teams meeting a member organised has a recording, create a Meeting Note automatically. Meetings organised by someone outside Bee Flow are not imported.')}
                        >
                            <Toggle on={!!cfg.autoImport} onClick={() => setCfg((c) => ({ ...c, autoImport: !c.autoImport }))} disabled={busy} />
                        </Row>
                        <Row
                            title={t('settings.teams_admin_auto_record', 'Switch on Teams recording for meetings members organise')}
                            desc={t('settings.teams_admin_auto_record_desc', 'When a member turns recording on for a meeting, Bee Flow sets Teams to record it automatically. Teams shows everyone in the call that it is being recorded.')}
                        >
                            <Toggle on={!!cfg.autoRecordConfig} onClick={() => setCfg((c) => ({ ...c, autoRecordConfig: !c.autoRecordConfig }))} disabled={busy} />
                        </Row>
                        <Row
                            title={t('settings.teams_notes_language', 'Default language')}
                            desc={t('settings.teams_notes_language_desc', 'Language used when transcribing your Teams recordings.')}
                        >
                            <select
                                value={cfg.language || 'nl'}
                                onChange={(e) => setCfg((c) => ({ ...c, language: e.target.value }))}
                                disabled={busy}
                                aria-label={t('settings.teams_notes_language', 'Default language')}
                                className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                            >
                                {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                            </select>
                        </Row>
                    </div>

                    <div className="flex items-center gap-3 mt-3">
                        <button
                            type="button" onClick={onSave} disabled={busy}
                            className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        >
                            {busy ? t('settings.teams_notes_saving', 'Saving…') : t('settings.teams_notes_save', 'Save')}
                        </button>
                        {message && (
                            <span className={`text-[12px] font-medium ${message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error)]'}`}>
                                {message.text}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
