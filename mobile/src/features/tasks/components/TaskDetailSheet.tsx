/**
 * A task in full: what it asks, when it next runs, what it answered last time,
 * and the things you can do to it. A sheet rather than a screen because every
 * one of those actions returns you straight to the list. Delete asks first:
 * the server removes the task for good.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { absoluteTime, previewValue } from '@/features/automations';
import { useConfirm } from '@/shared/patterns';
import { Button, Sheet, Text, useToast } from '@/shared/ui';

import { useDeleteTask, useToggleTask } from '../hooks/mutations';
import type { AiTask } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footer: { gap: theme.spacing.sm },
        block: { gap: theme.spacing.xs },
        answer: { padding: theme.spacing.md, borderRadius: theme.radii.md, backgroundColor: theme.colors.bgTertiary },
    });

function lastRunLine(task: AiTask, t: TranslateFn): string {
    const total = task.runCount ? ` · ${task.runCount} runs in total` : '';
    return `${t('mobile.tasks.last_run', 'Last run {when}', { when: timeAgo(task.lastRunAt, { suffix: true }) })}${total}`;
}

function TaskDetails({ task }: { task: AiTask }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const lastResult = previewValue(task.lastResult, 800);
    return (
        <>
            <View style={styles.block}>
                <Text variant="label" tone="tertiary">
                    IT ASKS
                </Text>
                <Text variant="body" selectable>
                    {task.prompt}
                </Text>
            </View>

            <View style={styles.block}>
                <Text variant="label" tone="tertiary">
                    SCHEDULE
                </Text>
                <Text variant="body">
                    {task.repeatInterval ? `Repeats ${task.repeatInterval}` : 'Runs once'}
                    {task.timezone ? ` · ${task.timezone}` : ''}
                </Text>
                {task.lastRunAt ? (
                    <Text variant="caption" tone="tertiary">
                        {lastRunLine(task, t)}
                    </Text>
                ) : null}
            </View>

            {lastResult ? (
                <View style={styles.block}>
                    <Text variant="label" tone="tertiary">
                        LAST ANSWER
                    </Text>
                    <View style={styles.answer}>
                        <Text variant="body" tone="secondary" selectable>
                            {lastResult}
                        </Text>
                    </View>
                </View>
            ) : null}
        </>
    );
}

/** Delete, after saying what it costs: the server removes the task for good. */
function useRemoveTask(onDone: () => void, onError: (error: Error) => void) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const remove = useDeleteTask({
        onSuccess: () => {
            toast(t('mobile.tasks.deleted', 'Task deleted'), 'success');
            onDone();
        },
        onError,
    });
    const ask = async (task: AiTask) => {
        const ok = await confirm({
            title: t('mobile.tasks.delete_title', 'Delete this task?'),
            message: t('mobile.tasks.delete_message', '“{title}” stops running and cannot be restored.', { title: task.title }),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) remove.mutate(task.id);
    };
    return { ask, isPending: remove.isPending };
}

export function TaskDetailSheet({ task, onClose }: { task: AiTask | null; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const onError = (error: Error) => toast(describeError(error).message, 'error');

    const toggle = useToggleTask({
        onSuccess: (isActive) => {
            toast(isActive ? t('mobile.tasks.resumed', 'Task resumed') : t('mobile.tasks.paused', 'Task paused'), 'success');
            onClose();
        },
        onError,
    });
    const remove = useRemoveTask(onClose, onError);

    let subtitle: string | undefined;
    if (task) {
        subtitle = task.isActive
            ? t('mobile.tasks.next_run', 'Next {when}', { when: absoluteTime(task.nextRunAt).toLowerCase() })
            : t('routines.paused', 'Paused');
    }

    return (
        <Sheet
            visible={Boolean(task)}
            onClose={onClose}
            title={task?.title ?? t('mobile.tasks.task', 'Task')}
            subtitle={subtitle}
            footer={
                task ? (
                    <View style={styles.footer}>
                        <Button
                            label={task.isActive ? t('mobile.tasks.pause', 'Pause this task') : t('mobile.tasks.resume', 'Resume this task')}
                            variant="secondary"
                            fullWidth
                            loading={toggle.isPending}
                            onPress={() => toggle.mutate(task.id)}
                        />
                        <Button
                            label={t('common.delete', 'Delete')}
                            variant="danger"
                            fullWidth
                            loading={remove.isPending}
                            onPress={() => void remove.ask(task)}
                            testID="task-delete"
                        />
                    </View>
                ) : undefined
            }
        >
            {task ? <TaskDetails task={task} /> : null}
        </Sheet>
    );
}
