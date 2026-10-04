/** One AI task: when it next runs, whether its last run failed, and a run button. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { absoluteTime, statusLabel, statusToken } from '@/features/automations';
import { Badge, Icon, IconButton, ListRow } from '@/shared/ui';

import type { AiTask } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } });

function subtitleOf(task: AiTask, t: TranslateFn): string {
    if (!task.isActive) return t('automations.paused', 'Paused');
    return task.nextRunAt
        ? t('mobile.tasks.next_run', 'Next {when}', { when: absoluteTime(task.nextRunAt).toLowerCase() })
        : t('automations.active', 'Active');
}

export function TaskRow({
    task,
    onPress,
    onRun,
    running,
}: {
    task: AiTask;
    onPress: () => void;
    onRun: () => void;
    running: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const token = task.lastStatus ? statusToken(task.lastStatus) : null;

    return (
        <ListRow
            title={task.title}
            subtitle={subtitleOf(task, t)}
            wrapTitle
            leading={
                <Icon
                    name="Cpu"
                    size={18}
                    color={task.isActive ? theme.colors.accentPrimary : theme.colors.textMuted}
                />
            }
            trailing={
                <View style={styles.trailing}>
                    {token && token.tone === 'error' ? (
                        <Badge label={statusLabel(t, token)} tone={token.tone} />
                    ) : null}
                    <IconButton
                        icon={<Icon name="Play" size={16} color={theme.colors.textSecondary} />}
                        accessibilityLabel={`Run ${task.title} now`}
                        onPress={onRun}
                        disabled={running}
                    />
                </View>
            }
            onPress={onPress}
        />
    );
}
