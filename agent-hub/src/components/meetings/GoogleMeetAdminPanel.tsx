import { useState } from 'react';
import { useOrgNotesSettingsQuery } from '../../api/queries/meetingNotesSettings';
import { languageOptions } from '@/components/settings/shared/settingsPrimitives';
import { InheritHint, InheritSelect, InheritSwitch, OrgSettingsLoadError, orgFormFromAnswer } from '@/components/settings/shared/orgSettingFields';
import { useTranslation } from '../../hooks/useTranslation';
import { panelOrgId } from '@/utils/adminAccess';
import { useOrgNotesSave } from './useOrgNotesSave';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import SaveFooter from '@/components/shared/SaveFooter';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_ERROR } from '@/components/shared/adminUi';

interface GoogleMeetAdminPanelProps {
    user?: { organizationId?: string | null } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** `null` = each member decides (see orgSettingFields). */
interface GoogleMeetConfig {
    autoImport: boolean | null;
    autoRecordConfig: boolean | null;
    importScope: string | null;
    language: string | null;
    /** Not on the panel; kept as loaded so a save does not pin it. */
    lookbackHours?: number | null;
}

const INHERITABLE = ['autoImport', 'autoRecordConfig', 'importScope', 'language', 'lookbackHours'] as const;
const DEFAULT_CFG: GoogleMeetConfig = { autoImport: null, autoRecordConfig: null, importScope: null, language: null, lookbackHours: null };

/**
 * Org-level Google Meet → Meeting Notes settings: one card of the Meeting
 * notes page, like the Talk and Teams cards. A concrete org value takes
 * precedence over each member's own setting; a field on "Each member decides"
 * is sent as null.
 */
export default function GoogleMeetAdminPanel({ user, orgId: orgIdProp }: GoogleMeetAdminPanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const settingsQuery = useOrgNotesSettingsQuery<GoogleMeetConfig>('gmeet', orgId);
    const [draft, setDraft] = useState<GoogleMeetConfig | null>(null);
    // Edits replace the whole config (defaults, then the server answer, then the person's changes).
    // The save sends it whole, so a field the org has no opinion on must stay null here.
    const cfg: GoogleMeetConfig = draft ?? { ...DEFAULT_CFG, ...orgFormFromAnswer(settingsQuery.data, INHERITABLE) };
    const setCfg = (update: (c: GoogleMeetConfig) => GoogleMeetConfig) => setDraft(update(cfg));
    const loading = !!orgId && settingsQuery.isPending;
    const { saveState, error, saving, save } = useOrgNotesSave('gmeet', orgId, cfg);

    if (!orgId) return null;

    return (
        <SettingsGroup
            title={t('meetings.admin_sources.meet_title', 'Google Meet')}
            description={t('meetings.admin_meet.intro', 'Turn recorded Google Meet meetings into Meeting Notes — transcript, summary and action items, transcribed by your organisation\'s configured transcription engine. These org settings override each member\'s personal settings.')}
        >
            <InheritHint />
            <LoadingState loading={loading} error={settingsQuery.isError ? true : null} errorFallback={() => <OrgSettingsLoadError />}>
                <SettingsList>
                    <SettingRow label={t('meetings.admin_meet.auto_import', 'Auto-import recorded Meet meetings')} hint={t('meetings.admin_meet.auto_import_desc', 'When a recording of a member\'s Google Meet call appears in Drive, create a Meeting Note automatically. Recording must be started in Meet — requires Google Workspace Business Standard or higher.')}>
                        <InheritSwitch ariaLabel={t('meetings.admin_meet.auto_import', 'Auto-import recorded Meet meetings')} value={cfg.autoImport} onChange={(v) => setCfg((c) => ({ ...c, autoImport: v }))} disabled={saving} />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_meet.auto_record', 'Pre-enable auto-recording for meetings members organize')} hint={t('meetings.admin_meet.auto_record_desc', 'Configure Meet to start recording automatically for meetings members organize, so nothing is missed.')}>
                        <InheritSwitch ariaLabel={t('meetings.admin_meet.auto_record', 'Pre-enable auto-recording for meetings members organize')} value={cfg.autoRecordConfig} onChange={(v) => setCfg((c) => ({ ...c, autoRecordConfig: v }))} disabled={saving} />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_meet.which', 'Which meetings')} hint={t('meetings.admin_meet.which_desc', 'Import only meetings members organize, or every Meet meeting on their calendars.')}>
                        <InheritSelect ariaLabel={t('meetings.admin_meet.which', 'Which meetings')} value={cfg.importScope} disabled={saving} onChange={(v) => setCfg((c) => ({ ...c, importScope: v }))}
                            options={[{ value: 'organizer', label: t('meetings.admin_meet.scope_organizer', 'Meetings they organize') }, { value: 'calendar', label: t('meetings.admin_meet.scope_calendar', 'All calendar meetings') }]} />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_meet.language', 'Default language')} hint={t('meetings.admin_meet.language_desc', 'Language used when transcribing Meet recordings.')}>
                        <InheritSelect
                            ariaLabel={t('meetings.admin_meet.language', 'Default language')}
                            value={cfg.language} onChange={(v) => setCfg((c) => ({ ...c, language: v }))} disabled={saving}
                            options={languageOptions(cfg.language).map((l) => ({ value: l.code, label: l.label }))}
                        />
                    </SettingRow>
                </SettingsList>
                {error && <p role="alert" className={ALERT_ERROR}>{error}</p>}
                <SaveFooter onSave={save} saving={saving} saveState={saveState} onRetry={save} />
            </LoadingState>
        </SettingsGroup>
    );
}
