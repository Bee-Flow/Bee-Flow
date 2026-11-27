import { useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import { languageOptions } from '@/components/settings/shared/settingsPrimitives';
import { InheritHint, InheritSelect, InheritSwitch, OrgSettingsLoadError, orgFormFromAnswer } from '@/components/settings/shared/orgSettingFields';
import {
    useTeamsNotesOrgSettings,
    useSaveTeamsNotesOrgSettings,
    type TeamsNotesSettings,
} from '../../api/queries/teamsMeetingNotes';
import { errorMessage } from '../../utils/caughtError';
import TeamsSetupCards from './teamsSetup/TeamsSetupCards';
import { homeOrgIdOf, panelOrgId } from '@/utils/adminAccess';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import SaveFooter from '@/components/shared/SaveFooter';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_ERROR } from '@/components/shared/adminUi';

/**
 * Org-level Microsoft Teams → Meeting Notes settings, next to the Google Meet
 * panel. A concrete org value takes precedence over each member's own
 * setting; a field on "Each member decides" is sent as null, the only way to
 * hand it back (the server coerces a field left out of the body).
 *
 * These are the choices about what happens with the meetings. What a member
 * needs, the two ways Bee Flow can reach the meetings, the test and who is
 * ready are the setup cards (teamsSetup/TeamsSetupCards): they follow below
 * unless `showSetup` is false, because the admin dashboard draws them on its
 * Microsoft 365 row instead.
 */
const INHERITABLE = ['source', 'autoImport', 'autoRecordConfig', 'language', 'lookbackHours'] as const;
const DEFAULT_CFG: TeamsNotesSettings = { source: null, autoImport: null, autoRecordConfig: null, language: null, lookbackHours: null };

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface TeamsAdminPanelProps {
    user?: { organizationId?: string | null } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
    /** Draw the Teams setup cards under the settings. Default true (outside the admin dashboard). */
    showSetup?: boolean;
}

export default function TeamsAdminPanel({ user, orgId: orgIdProp, showSetup = true }: TeamsAdminPanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const homeOrg = orgId !== null && orgId === homeOrgIdOf(user);
    const query = useTeamsNotesOrgSettings(orgId);
    const save = useSaveTeamsNotesOrgSettings(orgId);
    const [draft, setDraft] = useState<TeamsNotesSettings | null>(null);
    // The whole form is saved, so a field the org has no opinion on must stay null here.
    const cfg: TeamsNotesSettings = draft ?? { ...DEFAULT_CFG, ...orgFormFromAnswer(query.data, INHERITABLE) };
    const setCfg = (update: (c: TeamsNotesSettings) => TeamsNotesSettings) => setDraft(update(cfg));
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [error, setError] = useState<string | null>(null);

    if (!orgId) return null;
    const busy = save.isPending;

    const onSave = async () => {
        setError(null);
        setSaveState('saving');
        try {
            await save.mutateAsync(cfg);
            setSaveState('saved');
        } catch (e) {
            setError(errorMessage(e) ?? null);
            setSaveState('error');
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <SettingsGroup
                title={t('meetings.admin_sources.teams_title', 'Microsoft Teams')}
                description={t('teams_setup.ui.settings_intro')}
            >
                <InheritHint />
                <LoadingState loading={query.isLoading} error={query.isError ? true : null} errorFallback={() => <OrgSettingsLoadError />}>
                    <SettingsList>
                        <SettingRow
                            label={t('teams_setup.source.label')}
                            hint={t('teams_setup.source.hint')}
                            expanded={cfg.source === 'transcript' ? <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="teams-source-transcript-note">{t('teams_setup.source.transcript_note')}</p> : undefined}
                        >
                            <InheritSelect
                                ariaLabel={t('teams_setup.source.label')}
                                value={cfg.source ?? null} disabled={busy}
                                onChange={(v) => setCfg((c) => ({ ...c, source: v === 'transcript' || v === 'recording' ? v : null }))}
                                options={[
                                    { value: 'recording', label: t('teams_setup.source.recording') },
                                    { value: 'transcript', label: t('teams_setup.source.transcript') },
                                ]}
                            />
                        </SettingRow>
                        <SettingRow
                            label={t('settings.teams_admin_auto_import', 'Auto-import recorded Teams meetings')}
                            hint={t('settings.teams_admin_auto_import_desc', 'When a Teams meeting a member organised has a recording, create a Meeting Note automatically. Meetings organised by someone outside Bee Flow are not imported.')}
                        >
                            <InheritSwitch ariaLabel={t('settings.teams_admin_auto_import', 'Auto-import recorded Teams meetings')} value={cfg.autoImport} onChange={(v) => setCfg((c) => ({ ...c, autoImport: v }))} disabled={busy} />
                        </SettingRow>
                        <SettingRow
                            label={t('settings.teams_admin_auto_record', 'Switch on Teams recording for meetings members organise')}
                            hint={t('settings.teams_admin_auto_record_desc', 'When a member turns recording on for a meeting, Bee Flow sets Teams to record it automatically. Teams shows everyone in the call that it is being recorded.')}
                        >
                            <InheritSwitch ariaLabel={t('settings.teams_admin_auto_record', 'Switch on Teams recording for meetings members organise')} value={cfg.autoRecordConfig} onChange={(v) => setCfg((c) => ({ ...c, autoRecordConfig: v }))} disabled={busy} />
                        </SettingRow>
                        <SettingRow
                            label={t('settings.teams_notes_language', 'Default language')}
                            hint={t('settings.teams_notes_language_desc', 'Language used when transcribing your Teams recordings.')}
                        >
                            <InheritSelect
                                ariaLabel={t('settings.teams_notes_language', 'Default language')}
                                value={cfg.language} onChange={(v) => setCfg((c) => ({ ...c, language: v }))} disabled={busy}
                                options={languageOptions(cfg.language).map((l) => ({ value: l.code, label: l.label }))}
                            />
                        </SettingRow>
                    </SettingsList>
                    {error && <p role="alert" className={ALERT_ERROR}>{error}</p>}
                    <SaveFooter onSave={onSave} saving={busy} saveState={saveState} onRetry={onSave} />
                </LoadingState>
            </SettingsGroup>

            {/* Setting up and testing: also shown when the settings could not be read, but only for the own organisation. */}
            {showSetup && <TeamsSetupCards homeOrg={homeOrg} />}
        </div>
    );
}
