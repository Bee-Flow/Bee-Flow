/** Who the agent is: picture (an emoji), name, role description and category. */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useAgentCategories } from '@/features/agents/hooks/queries';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { ActionMenu, Group, Section, SettingRow, TextField } from '@/shared/ui';

import { AgentAvatar } from '../AgentAvatar';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fields: { gap: theme.spacing.md },
        avatarRow: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.md },
        avatarField: { flex: 1 },
    });

/** The first grapheme-ish run of what was typed: the picture is one emoji. */
function firstSymbol(text: string): string {
    return Array.from(text.trim()).slice(0, 2).join('');
}

export function IdentityFields({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const categories = useAgentCategories();
    const [picking, setPicking] = useState(false);
    const { draft, errors, patch } = form;
    const category = categories.data?.find((c) => c.id === draft.categoryId);
    const none = t('agent_wizard.field.category_none', '— None —');

    return (
        <Section title={t('agent_wizard.section.identity', 'Identity & Model')}>
            <View style={styles.fields}>
                <View style={styles.avatarRow}>
                    <AgentAvatar name={draft.name} avatar={draft.avatar} size={48} />
                    <TextField
                        label={t('agent_wizard.builder.avatar_prompt', 'Avatar emoji')}
                        value={draft.avatar}
                        onChangeText={(text) => patch({ avatar: firstSymbol(text) })}
                        editable={!disabled}
                        containerStyle={styles.avatarField}
                    />
                </View>
                <TextField
                    label={t('agent.name', 'Agent Name')}
                    placeholder={t('agent_wizard.builder.name_placeholder', 'Agent name')}
                    value={draft.name}
                    onChangeText={(name) => patch({ name })}
                    error={errors.name}
                    editable={!disabled}
                    maxLength={200}
                />
                <TextField
                    label={t('agent_wizard.builder.role_description_label', 'Role description')}
                    hint={t('agent_wizard.builder.role_description_help', 'A short description of what this agent does. Shown to users in the agent picker.')}
                    placeholder={t('agent_wizard.field.role_description_placeholder', 'e.g. Analyzes trends in CSV files')}
                    value={draft.description}
                    onChangeText={(description) => patch({ description })}
                    editable={!disabled}
                    multiline
                    maxLines={4}
                />
                <Group>
                    <SettingRow
                        label={t('agent_wizard.field.category', 'Category')}
                        value={category?.name ?? none}
                        onPress={disabled ? undefined : () => setPicking(true)}
                    />
                </Group>
            </View>
            <ActionMenu
                visible={picking}
                onClose={() => setPicking(false)}
                title={t('agent_wizard.field.category', 'Category')}
                items={[
                    { id: 'none', label: none, selected: !draft.categoryId, onPress: () => patch({ categoryId: null }) },
                    ...(categories.data ?? []).map((c) => ({
                        id: c.id,
                        label: c.name,
                        selected: c.id === draft.categoryId,
                        onPress: () => patch({ categoryId: c.id }),
                    })),
                ]}
            />
        </Section>
    );
}
