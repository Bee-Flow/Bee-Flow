/**
 * Conversation starters: the prompts offered on an empty chat with this
 * agent. A short, fixed list the person writes, so rows rather than a list view.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { Button, Icon, IconButton, Section, TextField } from '@/shared/ui';

/** The editor keeps at most this many — the profile shows them all. */
export const MAX_STARTERS = 8;

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        list: { gap: theme.spacing.sm },
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
        field: { flex: 1 },
    });

export function StartersField({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const starters = form.draft.starterPrompts;
    const set = (next: string[]) => form.patch({ starterPrompts: next });

    return (
        <Section title={t('agent.starter_prompts', 'Starter Prompts')}>
            <View style={styles.list}>
                {starters.map((text, index) => (
                    // Index keys: rows are edited in place and never reordered.
                    <View key={index} style={styles.row}>
                        <TextField
                            value={text}
                            onChangeText={(next) => set(starters.map((s, i) => (i === index ? next : s)))}
                            editable={!disabled}
                            accessibilityLabel={t('agent.starter_prompts', 'Starter Prompts')}
                            containerStyle={styles.field}
                        />
                        {disabled ? null : (
                            <IconButton
                                icon={<Icon name="X" size={18} color={theme.colors.textSecondary} />}
                                accessibilityLabel={t('common.remove', 'Remove')}
                                onPress={() => set(starters.filter((_, i) => i !== index))}
                            />
                        )}
                    </View>
                ))}
                {disabled || starters.length >= MAX_STARTERS ? null : (
                    <Button label={t('common.add', 'Add')} iconName="Plus" variant="secondary" size="sm" onPress={() => set([...starters, ''])} />
                )}
            </View>
        </Section>
    );
}
