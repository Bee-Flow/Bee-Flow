/**
 * Summary templates: the saved styles Meeting Notes' Regenerate offers, and
 * the default a new meeting's summary is written in. The phone's copy of the
 * web's settings section (agent-hub SummaryTemplatesSection.jsx) and, for an
 * org admin, its org and group scopes (SummaryTemplatesAdminPanel.jsx) in one
 * list. Only what this person may write opens the editor; an org or group
 * template they merely see is listed read-only (see templateRows).
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Icon, IconButton, Screen, ScreenHeader, Text } from '@/shared/ui';

import { TemplateEditorSheet } from '../components/TemplateEditorSheet';
import { TemplateRow } from '../components/TemplateRow';
import { useOrgTemplates, useSummaryTemplates } from '../hooks/queries';
import { templateRows } from '../model/draft';
import type { SummaryTemplate, TemplateListRow } from '../model/types';

const styles = StyleSheet.create({ intro: { paddingHorizontal: 16, paddingBottom: 12 } });

const keyOf = (row: TemplateListRow) => row.template.id;

export function SummaryTemplatesScreen() {
    const t = useTranslation();
    const theme = useTheme();
    const query = useSummaryTemplates();
    const canManageOrg = query.data?.canManageOrg ?? false;
    const org = useOrgTemplates(canManageOrg).data;
    const groups = org?.groups ?? [];
    // `undefined` is closed; `null` inside is a new template.
    const [editing, setEditing] = useState<{ template: SummaryTemplate | null } | undefined>(undefined);
    const rows = { ...query, data: query.data ? templateRows(query.data.custom, org?.templates ?? null) : undefined };
    const openNew = () => setEditing({ template: null });

    return (
        <Screen edges={['top']}>
            <ScreenHeader
                title={t('meeting_notes.template_personal_title', 'My summary templates')}
                actions={
                    <IconButton
                        icon={<Icon name="Plus" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('meeting_notes.template_new', 'New template…')}
                        onPress={openNew}
                    />
                }
            />
            <QueryList
                query={rows}
                keyExtractor={keyOf}
                renderItem={({ item }) => (
                    <TemplateRow
                        template={item.template}
                        groups={groups}
                        onPress={item.editable ? () => setEditing({ template: item.template }) : undefined}
                    />
                )}
                ListHeaderComponent={
                    <View style={styles.intro}>
                        <Text variant="caption" tone="tertiary">
                            {t(
                                'meeting_notes.template_personal_desc',
                                'Save your own summary styles for Meeting Notes. Pick one from the Regenerate menu, or set a default that new meetings use automatically.',
                            )}
                        </Text>
                    </View>
                }
                empty={{
                    icon: 'LayoutTemplate',
                    title: t('meeting_notes.template_personal_empty', "You haven't saved any templates yet."),
                    actionLabel: t('meeting_notes.template_new', 'New template…'),
                    onAction: openNew,
                }}
            />
            <TemplateEditorSheet
                visible={editing !== undefined}
                template={editing?.template ?? null}
                builtins={query.data?.builtins ?? []}
                canManageOrg={canManageOrg}
                groups={groups}
                onClose={() => setEditing(undefined)}
            />
        </Screen>
    );
}
