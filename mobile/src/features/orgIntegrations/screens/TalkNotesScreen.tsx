/**
 * Talk Meeting Notes (web: meetings/MeetingNotesAdminPanel.jsx): turn
 * Nextcloud Talk call recordings into Meeting Notes. These organisation
 * settings override each member's own. The whole document is saved back, so
 * a field the org left open ("no opinion") stays open unless it is changed.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { ChoiceGroup, OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Group, NoteRow, SaveBar, TextField, ToggleRow } from '@/shared/ui';

import { NotesLanguageGroup } from '../components/NotesLanguageGroup';
import { useSaveTalkNotes } from '../hooks/nextcloudMutations';
import { useTalkNotes } from '../hooks/nextcloudQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { useSettingsForm } from '../hooks/useSettingsForm';

/** The web's example folder. */
const FOLDER_EXAMPLE = '/Talk/Recording';

const styles = StyleSheet.create({ field: { padding: 12 } });

export function TalkNotesScreen() {
    const t = useTranslation();
    const access = useIntegrationAccess();
    const orgId = access.meetingNotes ? access.orgId : null;
    const query = useTalkNotes(orgId);
    const { form, saving, save } = useSettingsForm(query.data, useSaveTalkNotes(orgId));
    useConfirmLeave(form.dirty);

    return (
        <OrgSettingsFrame
            title={t('mobile.orgIntegrations.talk_title', 'Talk Meeting Notes')}
            subtitle={t('settings.nextcloud_sync', 'Nextcloud Sync')}
            allowed={access.meetingNotes}
            query={query}
            footer={<SaveBar dirty={form.dirty} saving={saving} onSave={() => void save()} onDiscard={form.reset} />}
        >
            {(data) => {
                const d = form.draft ?? data;
                return (
                    <>
                        <NoteRow>{t('mobile.orgIntegrations.talk_intro', "Turn Nextcloud Talk call recordings into Meeting Notes, transcribed by your organisation's configured transcription engine. These org settings override each member's personal settings.")}</NoteRow>
                        <Group>
                            <ToggleRow
                                testID="talk-auto-record"
                                label={t('mobile.orgIntegrations.talk_auto_record', 'Auto-record Talk meetings')}
                                description={t('mobile.orgIntegrations.talk_auto_record_desc', 'Automatically start recording calls members moderate (requires the Nextcloud recording backend).')}
                                value={d.autoRecord === true}
                                disabled={saving}
                                onValueChange={(v) => form.set('autoRecord', v)}
                            />
                            <ToggleRow
                                testID="talk-auto-transcribe"
                                label={t('mobile.orgIntegrations.talk_auto_transcribe', 'Auto-transcribe Talk recordings')}
                                description={t('mobile.orgIntegrations.talk_auto_transcribe_desc', 'When a new Talk recording appears, create a Meeting Note automatically.')}
                                value={d.autoTranscribe === true}
                                disabled={saving}
                                onValueChange={(v) => form.set('autoTranscribe', v)}
                            />
                            <ToggleRow
                                testID="talk-post-back"
                                label={t('mobile.orgIntegrations.talk_post_back', 'Post summary back into Talk')}
                                description={t('mobile.orgIntegrations.talk_post_back_desc', 'After transcription, post the summary + action items into the conversation.')}
                                value={d.postSummaryBack === true}
                                disabled={saving}
                                onValueChange={(v) => form.set('postSummaryBack', v)}
                            />
                            <ToggleRow
                                testID="talk-insights"
                                label={t('mobile.orgIntegrations.talk_insights', 'Per-person meeting insights')}
                                description={t('mobile.orgIntegrations.talk_insights_desc', 'Show per-person statistics (talk time, longest monologue) on the meeting Insights panel. Off = members see only meeting-level metrics.')}
                                value={d.insightsPerPersonStats}
                                disabled={saving}
                                onValueChange={(v) => form.set('insightsPerPersonStats', v)}
                            />
                        </Group>
                        {d.autoRecord === true ? (
                            <>
                                <ChoiceGroup
                                    title={t('mobile.orgIntegrations.talk_which_calls', 'Which calls')}
                                    footer={t('mobile.orgIntegrations.talk_which_calls_desc', 'Record only scheduled calendar meetings, or every call a member moderates.')}
                                    choices={[
                                        { value: 'calendar', label: t('mobile.orgIntegrations.talk_calendar', 'Calendar meetings') },
                                        { value: 'all', label: t('mobile.orgIntegrations.talk_any', 'Any moderated call') },
                                    ]}
                                    value={d.autoRecordScope ?? 'calendar'}
                                    onChange={(v) => form.set('autoRecordScope', v)}
                                    disabled={saving}
                                />
                                <ChoiceGroup
                                    title={t('mobile.orgIntegrations.talk_quality', 'Recording quality')}
                                    footer={t('mobile.orgIntegrations.talk_quality_desc', 'Audio-only is smaller and faster to transcribe.')}
                                    choices={[
                                        { value: 'audio', label: t('mobile.orgIntegrations.talk_audio', 'Audio-only') },
                                        { value: 'video', label: t('mobile.orgIntegrations.talk_video', 'Video') },
                                    ]}
                                    value={d.recordingMode ?? 'audio'}
                                    onChange={(v) => form.set('recordingMode', v)}
                                    disabled={saving}
                                />
                            </>
                        ) : null}
                        <Group
                            title={t('mobile.orgIntegrations.talk_folder', 'Recordings folder')}
                            footer={t('mobile.orgIntegrations.talk_folder_desc', 'Nextcloud Files folder where Talk saves recordings — normally /Talk/Recording, with one subfolder per conversation.')}
                        >
                            <View style={styles.field}>
                                <TextField
                                    testID="talk-folder"
                                    placeholder={FOLDER_EXAMPLE}
                                    autoCapitalize="none"
                                    value={d.recordingFolder ?? ''}
                                    editable={!saving}
                                    onChangeText={(v) => form.set('recordingFolder', v)}
                                />
                            </View>
                        </Group>
                        <NotesLanguageGroup
                            value={d.language}
                            footer={t('mobile.orgIntegrations.talk_language_desc', 'Language used when auto-transcribing Talk recordings.')}
                            disabled={saving}
                            onChange={(v) => form.set('language', v)}
                        />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
