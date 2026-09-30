/**
 * Google Meet Meeting Notes (web: meetings/GoogleMeetAdminPanel.jsx): turn
 * recorded Google Meet meetings into Meeting Notes. These organisation
 * settings override each member's own; the whole document is saved back.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ChoiceGroup, OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Group, NoteRow, SaveBar, ToggleRow } from '@/shared/ui';

import { NotesLanguageGroup } from '../components/NotesLanguageGroup';
import { useSaveMeetNotes } from '../hooks/nextcloudMutations';
import { useMeetNotes } from '../hooks/nextcloudQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { useSettingsForm } from '../hooks/useSettingsForm';

export function MeetNotesScreen() {
    const t = useTranslation();
    const access = useIntegrationAccess();
    const orgId = access.meetingNotes ? access.orgId : null;
    const query = useMeetNotes(orgId);
    const { form, saving, save } = useSettingsForm(query.data, useSaveMeetNotes(orgId));
    useConfirmLeave(form.dirty);

    return (
        <OrgSettingsFrame
            title={t('mobile.orgIntegrations.meet_title', 'Google Meet Meeting Notes')}
            subtitle={t('settings.nextcloud_sync', 'Nextcloud Sync')}
            allowed={access.meetingNotes}
            query={query}
            footer={<SaveBar dirty={form.dirty} saving={saving} onSave={() => void save()} onDiscard={form.reset} />}
        >
            {(data) => {
                const d = form.draft ?? data;
                return (
                    <>
                        <NoteRow>{t('mobile.orgIntegrations.meet_intro', "Turn recorded Google Meet meetings into Meeting Notes — transcript, summary and action items, transcribed by your organisation's configured transcription engine. These org settings override each member's personal settings.")}</NoteRow>
                        <Group>
                            <ToggleRow
                                testID="meet-auto-import"
                                label={t('mobile.orgIntegrations.meet_auto_import', 'Auto-import recorded Meet meetings')}
                                description={t(
                                    'mobile.orgIntegrations.meet_auto_import_desc',
                                    "When a recording of a member's Google Meet call appears in Drive, create a Meeting Note automatically. Recording must be started in Meet — requires Google Workspace Business Standard or higher.",
                                )}
                                value={d.autoImport === true}
                                disabled={saving}
                                onValueChange={(v) => form.set('autoImport', v)}
                            />
                            <ToggleRow
                                testID="meet-auto-record"
                                label={t('mobile.orgIntegrations.meet_auto_record', 'Pre-enable auto-recording for meetings members organize')}
                                description={t('mobile.orgIntegrations.meet_auto_record_desc', 'Configure Meet to start recording automatically for meetings members organize, so nothing is missed.')}
                                value={d.autoRecordConfig === true}
                                disabled={saving}
                                onValueChange={(v) => form.set('autoRecordConfig', v)}
                            />
                        </Group>
                        <ChoiceGroup
                            title={t('mobile.orgIntegrations.meet_which', 'Which meetings')}
                            footer={t('mobile.orgIntegrations.meet_which_desc', 'Import only meetings members organize, or every Meet meeting on their calendars.')}
                            choices={[
                                { value: 'organizer', label: t('mobile.orgIntegrations.meet_organizer', 'Meetings they organize') },
                                { value: 'calendar', label: t('mobile.orgIntegrations.meet_calendar', 'All calendar meetings') },
                            ]}
                            value={d.importScope ?? 'organizer'}
                            onChange={(v) => form.set('importScope', v)}
                            disabled={saving}
                        />
                        <NotesLanguageGroup
                            value={d.language}
                            footer={t('mobile.orgIntegrations.meet_language_desc', 'Language used when transcribing Meet recordings.')}
                            disabled={saving}
                            onChange={(v) => form.set('language', v)}
                        />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
