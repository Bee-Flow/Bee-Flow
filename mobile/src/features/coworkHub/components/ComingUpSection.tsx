/**
 * The next few tasks and reminders, merged (at most five) — or, with none, the
 * two ways to make one.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { absoluteTime } from '@/features/automations';
import { Badge, Button, Card, Divider, Icon, ListRow, Section, Text } from '@/shared/ui';

import type { Upcoming } from '../model/hub';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        empty: { padding: theme.spacing.lg, gap: theme.spacing.md },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
    });

function NothingScheduled({ onNewTask, onNewReminder }: { onNewTask: () => void; onNewReminder: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.empty}>
            <Text variant="body" tone="tertiary">
                {t(
                    'mobile.cowork_hub.nothing_scheduled',
                    'Nothing scheduled. A task runs a prompt for you; a reminder just nudges you.',
                )}
            </Text>
            <View style={styles.actions}>
                <Button label={t('cowork.list.new', 'New task')} variant="secondary" onPress={onNewTask} />
                <Button label={t('mobile.cowork_hub.new_reminder', 'New reminder')} variant="secondary" onPress={onNewReminder} />
            </View>
        </View>
    );
}

export function ComingUpSection({
    upcoming,
    onNewTask,
    onNewReminder,
}: {
    upcoming: Upcoming[];
    onNewTask: () => void;
    onNewReminder: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <Section
            title={t('mobile.cowork_hub.coming_up', 'Coming up')}
            action={<Button label={t('project_home.overview.see_all', 'See all')} variant="ghost" onPress={() => router.push('/tasks')} />}
        >
            <Card padded={false}>
                {upcoming.length === 0 ? (
                    <NothingScheduled onNewTask={onNewTask} onNewReminder={onNewReminder} />
                ) : (
                    upcoming.map((item, index) => (
                        <View key={`${item.kind}:${item.id}`}>
                            {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                            <ListRow
                                title={item.title}
                                subtitle={absoluteTime(item.at)}
                                leading={
                                    <Icon
                                        name={item.kind === 'task' ? 'Cpu' : 'Bell'}
                                        size={16}
                                        color={theme.colors.textMuted}
                                    />
                                }
                                trailing={item.overdue ? <Badge label={t('mobile.cowork_hub.due', 'Due')} tone="warning" /> : undefined}
                                onPress={() => router.push('/tasks')}
                            />
                        </View>
                    ))
                )}
            </Card>
        </Section>
    );
}
