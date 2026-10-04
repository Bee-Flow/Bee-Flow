import React, { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { Toggle, Row, LANGS } from './shared/settingsPrimitives';
import { openMicrosoftOAuthPopup } from '../../lib/microsoftOAuthPopup';
import { API_BASE, authFetch } from '../../utils/helpers';
import {
    useTeamsNotesUserSettings,
    useSaveTeamsNotesUserSettings,
    useInvalidateTeamsMeetingNotes,
    type TeamsNotesSettings,
} from '../../api/queries/teamsMeetingNotes';

/**
 * Personal Microsoft Teams → Meeting Notes settings. Self-hides while loading,
 * when Meeting Notes is not licensed for this account (the settings request
 * fails) and when Microsoft 365 is not connected. Connected without the Teams
 * permissions → a reconnect prompt instead of the rows. The organisation's
 * settings, where set, win per field.
 */
export default function TeamsMeetingNotesSection() {
    const { t } = useTranslation();
    const query = useTeamsNotesUserSettings(true);
    const save = useSaveTeamsNotesUserSettings();
    const invalidate = useInvalidateTeamsMeetingNotes();
    const [cfg, setCfg] = useState<TeamsNotesSettings>({ autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 });
    const [reauthing, setReauthing] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const data = query.data;
    useEffect(() => {
        if (!data) return;
        const { connection: _connection, ...settings } = data;
        setCfg((prev) => ({ ...prev, ...settings }));
    }, [data]);

    if (query.isLoading || query.error || !data?.connection?.microsoftConnected) return null;
    const { connection } = data;

    const onSave = async () => {
        setMessage(null);
        try {
            await save.mutateAsync(cfg);
            setMessage({ type: 'success', text: t('settings.teams_notes_saved', 'Saved') });
        } catch (e) {
            setMessage({ type: 'error', text: (e as Error).message });
        }
    };

    const reauthorize = async () => {
        setReauthing(true);
        setMessage(null);
        try {
            const result = await openMicrosoftOAuthPopup({ authFetch, apiBase: API_BASE });
            if (result.success) await invalidate();
        } catch (e) {
            setMessage({ type: 'error', text: (e as Error).message || t('settings.teams_notes_reauth_failed', 'Could not start the Microsoft reconnect. Try again.') });
        } finally {
            setReauthing(false);
        }
    };

    const busy = save.isPending;

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-[var(--accent-secondary)]" />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('settings.teams_notes_title', 'Microsoft Teams Meeting Notes')}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('settings.teams_notes_intro', 'Turn the Teams meetings you organise into Meeting Notes — Bee Flow transcribes the Teams recording itself. Per-meeting toggles live in the Upcoming tab of Meeting Notes. Your organisation’s settings, where set, take precedence.')}
            </p>

            {!connection.teamsScopesGranted ? (
                <div className="rounded-xl px-5 py-4 border bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] border-[color-mix(in_srgb,var(--warning)_35%,transparent)]">
                    <p className="text-[12px] text-[var(--warning-ink)]">
                        {t('settings.teams_notes_reconsent', 'Your Microsoft 365 account is connected, but Meeting Notes needs extra Teams permissions to import your meeting recordings. Reconnect to grant them — your Outlook and OneDrive access is kept. Your Microsoft 365 admin may need to approve them.')}
                    </p>
                    <button
                        type="button" onClick={reauthorize} disabled={reauthing}
                        className="mt-2.5 px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--warning)] text-[var(--accent-primary-fg)]"
                    >
                        {reauthing ? t('settings.teams_notes_opening', 'Opening Microsoft…') : t('meetings.teams_reauthorize', 'Reconnect Microsoft 365')}
                    </button>
                    {message?.type === 'error' && <p className="text-[11px] mt-2 text-[var(--error)]">{message.text}</p>}
                </div>
            ) : (
                <>
                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        <Row
                            title={t('settings.teams_notes_auto_import', 'Auto-import my recorded Teams meetings')}
                            desc={t('settings.teams_notes_auto_import_desc', 'When a Teams meeting you organised has a recording, create a Meeting Note automatically. Only meetings you organise can be imported.')}
                        >
                            <Toggle on={!!cfg.autoImport} onClick={() => setCfg((c) => ({ ...c, autoImport: !c.autoImport }))} disabled={busy} />
                        </Row>
                        <Row
                            title={t('settings.teams_notes_auto_record', 'Also switch on Teams recording for meetings I organise')}
                            desc={connection.hasMeetingWriteScope
                                ? t('settings.teams_notes_auto_record_desc', 'When you turn recording on for a meeting, Bee Flow sets Teams to record it automatically. Teams shows everyone in the call that it is being recorded.')
                                : t('settings.teams_notes_auto_record_noscope', 'Needs the permission to change your Teams meetings — reconnect Microsoft 365 to grant it.')}
                        >
                            <Toggle on={!!cfg.autoRecordConfig} onClick={() => setCfg((c) => ({ ...c, autoRecordConfig: !c.autoRecordConfig }))} disabled={busy || !connection.hasMeetingWriteScope} />
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
