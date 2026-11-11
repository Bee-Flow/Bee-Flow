import { useState } from 'react';
import { Users, Loader2 } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { languageOptions, Row } from '@/components/settings/shared/settingsPrimitives';
import { InheritHint, InheritSelect, InheritSwitch, OrgSettingsLoadError, orgFormFromAnswer } from '@/components/settings/shared/orgSettingFields';
import {
    useTeamsNotesOrgSettings,
    useSaveTeamsNotesOrgSettings,
    type TeamsNotesSettings,
} from '../../api/queries/teamsMeetingNotes';
import { errorMessage } from '../../utils/caughtError';
import TeamsSetupGuide from './teamsSetup/TeamsSetupGuide';
import TeamsConsentLinkCard from './teamsSetup/TeamsConsentLinkCard';
import TeamsConnectionTest from './teamsSetup/TeamsConnectionTest';
import TeamsMembersOverview from './teamsSetup/TeamsMembersOverview';
import TeamsAppImportPanel from './teamsSetup/TeamsAppImportPanel';
import { panelOrgId } from '@/utils/adminAccess';

/**
 * Org-level Microsoft Teams → Meeting Notes settings, next to the Google Meet
 * panel. A concrete org value takes precedence over each member's own
 * setting; a field on "Each member decides" is sent as null, the only way to
 * hand it back (the server coerces a field left out of the body).
 *
 * What the admin needs to know is said here, not discovered later: the app
 * registration needs admin consent for the Teams permissions, and only the
 * organizer of a meeting can import it. Below the settings: the setup guide,
 * the admin consent link, a test of the admin's own connection, organisation-wide
 * import (option B, application permissions) and the members overview (all on
 * /api/teams-setup, for the session organisation).
 */
const INHERITABLE = ['autoImport', 'autoRecordConfig', 'language', 'lookbackHours'] as const;
const DEFAULT_CFG: TeamsNotesSettings = { autoImport: null, autoRecordConfig: null, language: null, lookbackHours: null };

/** `orgId`: the organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
export default function TeamsAdminPanel({ user, orgId: orgIdProp }: { user?: { organizationId?: string | null } | null; orgId?: string | null }) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const query = useTeamsNotesOrgSettings(orgId);
    const save = useSaveTeamsNotesOrgSettings(orgId);
    const [draft, setDraft] = useState<TeamsNotesSettings | null>(null);
    // The whole form is saved, so a field the org has no opinion on must stay null here.
    const cfg: TeamsNotesSettings = draft ?? { ...DEFAULT_CFG, ...orgFormFromAnswer(query.data, INHERITABLE) };
    const setCfg = (update: (c: TeamsNotesSettings) => TeamsNotesSettings) => setDraft(update(cfg));
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string | undefined } | null>(null);

    if (!orgId) return null;
    const busy = save.isPending;

    const onSave = async () => {
        setMessage(null);
        try {
            await save.mutateAsync(cfg);
            setMessage({ type: 'success', text: t('settings.teams_notes_saved', 'Saved') });
        } catch (e) {
            setMessage({ type: 'error', text: errorMessage(e) });
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
                {t('teams_setup.ui.admin_intro')}
            </p>
            <InheritHint />

            {query.isLoading ? (
                <div className="flex items-center gap-2 px-5 py-4 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-secondary)]" />
                    <span className="text-[13px] text-[var(--text-muted)]">{t('common.loading', 'Loading…')}</span>
                </div>
            ) : query.isError ? <OrgSettingsLoadError /> : (
                <>
                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        <Row
                            title={t('settings.teams_admin_auto_import', 'Auto-import recorded Teams meetings')}
                            desc={t('settings.teams_admin_auto_import_desc', 'When a Teams meeting a member organised has a recording, create a Meeting Note automatically. Meetings organised by someone outside Bee Flow are not imported.')}
                        >
                            <InheritSwitch ariaLabel={t('settings.teams_admin_auto_import', 'Auto-import recorded Teams meetings')} value={cfg.autoImport} onChange={(v) => setCfg((c) => ({ ...c, autoImport: v }))} disabled={busy} />
                        </Row>
                        <Row
                            title={t('settings.teams_admin_auto_record', 'Switch on Teams recording for meetings members organise')}
                            desc={t('settings.teams_admin_auto_record_desc', 'When a member turns recording on for a meeting, Bee Flow sets Teams to record it automatically. Teams shows everyone in the call that it is being recorded.')}
                        >
                            <InheritSwitch ariaLabel={t('settings.teams_admin_auto_record', 'Switch on Teams recording for meetings members organise')} value={cfg.autoRecordConfig} onChange={(v) => setCfg((c) => ({ ...c, autoRecordConfig: v }))} disabled={busy} />
                        </Row>
                        <Row
                            title={t('settings.teams_notes_language', 'Default language')}
                            desc={t('settings.teams_notes_language_desc', 'Language used when transcribing your Teams recordings.')}
                        >
                            <InheritSelect
                                ariaLabel={t('settings.teams_notes_language', 'Default language')}
                                value={cfg.language} onChange={(v) => setCfg((c) => ({ ...c, language: v }))} disabled={busy}
                                options={languageOptions(cfg.language).map((l) => ({ value: l.code, label: l.label }))}
                            />
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

            {/* Setting up and testing: always shown, also when the settings could not be read. */}
            <div className="mt-6 flex flex-col gap-6">
                <TeamsSetupGuide />
                <TeamsConsentLinkCard />
                <TeamsConnectionTest />
                <TeamsAppImportPanel />
                <TeamsMembersOverview />
            </div>
        </div>
    );
}
