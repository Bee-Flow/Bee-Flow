/**
 * Meeting templates (web: meetings/SummaryTemplatesAdminPanel.jsx): the
 * organisation's and its groups' Meeting Notes summary styles. Members pick
 * them from Regenerate; a default is applied to new meetings. The editor and
 * rows are features/meetingTemplates' own; a new template starts on the
 * organisation, as the web's panel does. Org admins with Meeting Notes.
 *
 * Like the web's Meeting Templates page (GoogleMeetAdminPanel under the
 * templates), it also opens the org's Google Meet meeting-notes settings:
 * Meet needs no Nextcloud, so they do not belong under Nextcloud Sync, which
 * only NC-bound orgs see. The route stays /org/nextcloud/meet for old links.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { sortTemplates, TemplateEditorSheet, TemplateRow, useOrgTemplates, useSummaryTemplates, type SummaryTemplate } from '@/features/meetingTemplates';
import { OrgLockedScreen } from '@/features/org';
import { QueryList } from '@/shared/patterns';
import { Group, Icon, IconButton, ListRow, Screen, ScreenHeader, Text } from '@/shared/ui';

import { useIntegrationAccess } from '../hooks/useIntegrationAccess';

const styles = StyleSheet.create({ band: { paddingHorizontal: 16, paddingBottom: 12 } });

const keyOf = (template: SummaryTemplate) => template.id;

export function MeetingTemplatesScreen() {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const { meetingNotes, admin } = useIntegrationAccess();
    const org = useOrgTemplates(meetingNotes);
    const builtins = useSummaryTemplates(meetingNotes).data?.builtins ?? [];
    // `undefined` is closed; `null` inside is a new template.
    const [editing, setEditing] = useState<{ template: SummaryTemplate | null } | undefined>(undefined);
    const title = t('settings.meeting_templates', 'Meeting Templates');
    // An admin without the licence is not "not an admin": say what is missing.
    if (!meetingNotes)
        return (
            <OrgLockedScreen
                title={title}
                denied={
                    admin
                        ? {
                              icon: 'Lock',
                              title: t('mobile.org.needs_licence_title', 'Not in your licence'),
                              message: t('mobile.org.meeting_templates_licence', 'Meeting templates come with Meeting Notes, which your licence does not include.'),
                          }
                        : undefined
                }
            />
        );
    const groups = org.data?.groups ?? [];
    const rows = { ...org, data: org.data ? sortTemplates(org.data.templates) : undefined };
    const openNew = () => setEditing({ template: null });

    return (
        <Screen edges={['top']}>
            <ScreenHeader
                title={title}
                subtitle={t('meeting_notes.template_org_title', 'Organization summary templates')}
                actions={
                    <IconButton
                        icon={<Icon name="Plus" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('meeting_notes.template_new', 'New template…')}
                        onPress={openNew}
                    />
                }
            />
            {/* Above the list, not its footer: QueryList drops header and footer while empty or loading. Gated with the screen (meetingNotes). */}
            <View style={styles.band}>
                <Group>
                    <ListRow
                        testID="meet-notes-link"
                        title={t('mobile.orgIntegrations.meet_title', 'Google Meet Meeting Notes')}
                        chevron
                        onPress={() => router.push('/org/nextcloud/meet')}
                    />
                </Group>
            </View>
            <QueryList
                query={rows}
                keyExtractor={keyOf}
                renderItem={({ item }) => <TemplateRow template={item} groups={groups} onPress={() => setEditing({ template: item })} />}
                ListHeaderComponent={
                    <View style={styles.band}>
                        <Text variant="caption" tone="tertiary">
                            {t(
                                'meeting_notes.template_org_desc',
                                'Add Meeting Notes summary styles for your whole organization or a specific group. Members pick them from the Regenerate menu; a default is applied to new meetings automatically.',
                            )}
                        </Text>
                    </View>
                }
                empty={{
                    icon: 'LayoutTemplate',
                    title: t('meeting_notes.template_org_empty', 'No organization or group templates yet.'),
                    actionLabel: t('meeting_notes.template_new', 'New template…'),
                    onAction: openNew,
                }}
            />
            <TemplateEditorSheet
                visible={editing !== undefined}
                template={editing?.template ?? null}
                builtins={builtins}
                canManageOrg
                groups={groups}
                defaultScope="org"
                onClose={() => setEditing(undefined)}
            />
        </Screen>
    );
}
