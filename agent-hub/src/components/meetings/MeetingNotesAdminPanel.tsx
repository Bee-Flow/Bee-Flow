import React, { useState } from 'react';
import { useOrgNotesSettingsQuery } from '../../api/queries/meetingNotesSettings';
import { languageOptions } from '@/components/settings/shared/settingsPrimitives';
import { InheritHint, InheritSelect, InheritSwitch, OrgSettingsLoadError, orgFormFromAnswer } from '@/components/settings/shared/orgSettingFields';
import { useTranslation } from '../../hooks/useTranslation';
import { panelOrgId } from '@/utils/adminAccess';
import { useOrgNotesSave } from './useOrgNotesSave';
import Toggle from '@/components/shared/Toggle';
import { FIELD_INPUT, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import SaveFooter from '@/components/shared/SaveFooter';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_ERROR } from '@/components/shared/adminUi';

interface MeetingNotesAdminPanelProps {
    user?: { organizationId?: string } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** `null` = each member decides (see orgSettingFields). `insightsPerPersonStats` is org-only. */
interface TalkNotesConfig {
    autoTranscribe: boolean | null;
    postSummaryBack: boolean | null;
    recordingFolder: string | null;
    language: string | null;
    autoRecord: boolean | null;
    autoRecordScope: string | null;
    recordingMode: string | null;
    insightsPerPersonStats: boolean;
}

const INHERITABLE = ['autoTranscribe', 'postSummaryBack', 'recordingFolder', 'language', 'autoRecord', 'autoRecordScope', 'recordingMode'] as const;
const DEFAULT_CFG: TalkNotesConfig = { autoTranscribe: null, postSummaryBack: null, recordingFolder: null, language: null, autoRecord: null, autoRecordScope: null, recordingMode: null, insightsPerPersonStats: true };

/**
 * Org-level Nextcloud Talk → Meeting Notes settings: one card of the Meeting
 * notes page, like the Google Meet and Teams cards. A concrete org value takes
 * precedence over each member's own setting; a field on "Each member decides"
 * is sent as null and hands the choice back to the member.
 */
export default function MeetingNotesAdminPanel({ user, orgId: orgIdProp }: MeetingNotesAdminPanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user) ?? undefined;
    // recordingFolder: Talk saves to <attachment folder>/Recording/<room token>/,
    // so /Talk/Recording is the default on a stock Nextcloud.
    const settingsQuery = useOrgNotesSettingsQuery<TalkNotesConfig>('talk', orgId);
    const [draft, setDraft] = useState<TalkNotesConfig | null>(null);
    // Edits replace the whole config (defaults, then the server answer, then the person's changes).
    // The save sends it whole, so a field the org has no opinion on must stay null here.
    const cfg: TalkNotesConfig = draft ?? { ...DEFAULT_CFG, ...orgFormFromAnswer(settingsQuery.data, INHERITABLE) };
    const setCfg = (update: (c: TalkNotesConfig) => TalkNotesConfig) => setDraft(update(cfg));
    const loading = !!orgId && settingsQuery.isPending;
    const { saveState, error, saving, save } = useOrgNotesSave('talk', orgId, cfg);

    if (!orgId) return null;

    return (
        <SettingsGroup
            title={t('meetings.admin_sources.talk_title', 'Nextcloud Talk')}
            description={t('meetings.admin_talk.intro', 'Turn Nextcloud Talk call recordings into Meeting Notes, transcribed by your organisation\'s configured transcription engine. These org settings override each member\'s personal settings.')}
        >
            <InheritHint />
            <LoadingState loading={loading} error={settingsQuery.isError ? true : null} errorFallback={() => <OrgSettingsLoadError />}>
                <SettingsList>
                    <SettingRow label={t('meetings.admin_talk.auto_record', 'Auto-record Talk meetings')} hint={t('meetings.admin_talk.auto_record_desc', 'Automatically start recording calls members moderate (requires the Nextcloud recording backend).')}>
                        <InheritSwitch ariaLabel={t('meetings.admin_talk.auto_record', 'Auto-record Talk meetings')} value={cfg.autoRecord} onChange={(v) => setCfg((c) => ({ ...c, autoRecord: v }))} disabled={saving} />
                    </SettingRow>
                    {/* Members who record use these too while the org leaves recording to them. */}
                    {cfg.autoRecord !== false && (
                        <>
                            <SettingRow label={t('meetings.admin_talk.which', 'Which calls')} hint={t('meetings.admin_talk.which_desc', 'Record only scheduled calendar meetings, or every call a member moderates.')}>
                                <InheritSelect ariaLabel={t('meetings.admin_talk.which', 'Which calls')} value={cfg.autoRecordScope} disabled={saving} onChange={(v) => setCfg((c) => ({ ...c, autoRecordScope: v }))}
                                    options={[{ value: 'calendar', label: t('meetings.admin_talk.scope_calendar', 'Calendar meetings') }, { value: 'all', label: t('meetings.admin_talk.scope_all', 'Any moderated call') }]} />
                            </SettingRow>
                            <SettingRow label={t('meetings.admin_talk.quality', 'Recording quality')} hint={t('meetings.admin_talk.quality_desc', 'Audio-only is smaller and faster to transcribe.')}>
                                <InheritSelect ariaLabel={t('meetings.admin_talk.quality', 'Recording quality')} value={cfg.recordingMode} disabled={saving} onChange={(v) => setCfg((c) => ({ ...c, recordingMode: v }))}
                                    options={[{ value: 'audio', label: t('meetings.admin_talk.audio_only', 'Audio-only') }, { value: 'video', label: t('meetings.admin_talk.video', 'Video') }]} />
                            </SettingRow>
                        </>
                    )}
                    <SettingRow label={t('meetings.admin_talk.auto_transcribe', 'Auto-transcribe Talk recordings')} hint={t('meetings.admin_talk.auto_transcribe_desc', 'When a new Talk recording appears, create a Meeting Note automatically.')}>
                        <InheritSwitch ariaLabel={t('meetings.admin_talk.auto_transcribe', 'Auto-transcribe Talk recordings')} value={cfg.autoTranscribe} onChange={(v) => setCfg((c) => ({ ...c, autoTranscribe: v }))} disabled={saving} />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_talk.post_summary', 'Post summary back into Talk')} hint={t('meetings.admin_talk.post_summary_desc', 'After transcription, post the summary + action items into the conversation.')}>
                        <InheritSwitch ariaLabel={t('meetings.admin_talk.post_summary', 'Post summary back into Talk')} value={cfg.postSummaryBack} onChange={(v) => setCfg((c) => ({ ...c, postSummaryBack: v }))} disabled={saving} />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_talk.folder', 'Recordings folder')} hint={t('meetings.admin_talk.folder_desc', 'Nextcloud Files folder where Talk saves recordings — normally /Talk/Recording, with one subfolder per conversation.')}>
                        <input
                            aria-label={t('meetings.admin_talk.folder', 'Recordings folder')}
                            type="text" value={cfg.recordingFolder ?? ''}
                            // Empty is "each member decides": the member's own folder, else /Talk/Recording.
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCfg((c) => ({ ...c, recordingFolder: e.target.value === '' ? null : e.target.value }))}
                            disabled={saving} placeholder={t('meetings.admin_org.member_decides', 'Each member decides')}
                            className={`${FIELD_INPUT} sm:w-48`}
                        />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_talk.insights', 'Per-person meeting insights')} hint={t('meetings.admin_talk.insights_desc', 'Show per-person statistics (talk time, longest monologue) on the meeting Insights panel. Off = members see only meeting-level metrics.')}>
                        <Toggle ariaLabel={t('meetings.admin_talk.insights', 'Per-person meeting insights')} checked={cfg.insightsPerPersonStats !== false} onChange={() => setCfg((c) => ({ ...c, insightsPerPersonStats: c.insightsPerPersonStats === false }))} disabled={saving} />
                    </SettingRow>
                    <SettingRow label={t('meetings.admin_talk.language', 'Default language')} hint={t('meetings.admin_talk.language_desc', 'Language used when auto-transcribing Talk recordings.')}>
                        <InheritSelect
                            ariaLabel={t('meetings.admin_talk.language', 'Default language')}
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
