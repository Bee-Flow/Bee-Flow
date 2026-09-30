/** The planned steps, numbered, each removable; the active ones say so. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { SessionSkill } from '@/features/chat/model/types';
import { Badge, Card, Divider, Icon, IconButton, ListRow, Text } from '@/shared/ui';


export function SessionSkillRows({
    skills,
    activated,
    onDelete,
}: {
    skills: SessionSkill[];
    activated: ReadonlySet<string>;
    onDelete: (skill: SessionSkill) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    if (skills.length === 0) {
        return (
            <Text variant="caption" tone="tertiary">
                {t('mobile.chat.details.no_steps', 'This conversation has no planned steps.')}
            </Text>
        );
    }
    return (
        <Card padded={false}>
            {skills.map((skill, index) => (
                <View key={skill.id}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <ListRow
                        title={skill.name}
                        subtitle={skill.description}
                        wrapTitle
                        chevron={false}
                        leading={
                            <Text variant="label" tone="tertiary">
                                {index + 1}
                            </Text>
                        }
                        trailing={
                            <View style={[styles.trailing, { gap: theme.spacing.sm }]}>
                                {activated.has(skill.id) ? <Badge label={t('skills.state_active', 'Active')} tone="accent" /> : null}
                                <IconButton
                                    icon={<Icon name="Trash2" size={16} color={theme.colors.error} />}
                                    tone="danger"
                                    accessibilityLabel={t('mobile.chat.details.remove_step', 'Remove the step {name}', { name: skill.name })}
                                    onPress={() => onDelete(skill)}
                                />
                            </View>
                        }
                    />
                </View>
            ))}
        </Card>
    );
}

const styles = StyleSheet.create({
    trailing: { flexDirection: 'row', alignItems: 'center' },
});
