/**
 * Create a scheduled AI task ("routine").
 *
 * A task is a prompt plus a time: the scheduler wakes up, runs the prompt
 * against the chosen tier, and drops the answer into notifications. Three
 * server rules shape this form, and getting any of them wrong is a 400 the
 * user cannot act on:
 *
 *   - `nextRunAt` is REQUIRED. There is no "start it whenever" — a task with
 *     no first run time is rejected outright (routes/aiTasks.js).
 *   - `repeatInterval` must be one of VALID_REPEAT_INTERVALS or empty. Empty
 *     means a one-off, which the server then deactivates after its single run.
 *   - There is a per-user cap (`maxTasks`, admin-configurable). The caller
 *     passes it in so the sheet can refuse BEFORE the round trip rather than
 *     after — a limit discovered on submit reads as a bug.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { WhenPicker } from './WhenPicker';
import { useTheme } from '../../../theme/ThemeProvider';
import { Chip } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Banner, describeError } from '../../../ui/Feedback';
import { TextField } from '../../../ui/Input';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { useToast } from '../../../ui/Toast';
import { automateKeys, createTask } from '../api';
import { REPEAT_INTERVALS, type RepeatInterval } from '../types';

const REPEAT_LABELS: Record<RepeatInterval | 'once', string> = {
    once: 'Once',
    hourly: 'Hourly',
    daily: 'Daily',
    weekdays: 'Weekdays',
    weekly: 'Weekly',
    biweekly: 'Every 2 weeks',
    monthly: 'Monthly',
    quarterly: 'Every 3 months',
    yearly: 'Yearly',
};

export function TaskSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [title, setTitle] = useState('');
    const [prompt, setPrompt] = useState('');
    const [repeat, setRepeat] = useState<RepeatInterval | null>(null);
    const [startNow, setStartNow] = useState(false);
    const [when, setWhen] = useState(() => {
        const next = new Date();
        next.setHours(next.getHours() + 1, 0, 0, 0);
        return next;
    });

    const reset = () => {
        setTitle('');
        setPrompt('');
        setRepeat(null);
        setStartNow(false);
    };

    const mutation = useMutation({
        mutationFn: () =>
            createTask({
                title: title.trim(),
                prompt: prompt.trim(),
                nextRunAt: when.toISOString(),
                repeatInterval: repeat,
                // The device's own zone, so "every day at 09:00" means 09:00
                // where the person is, not where the server happens to run.
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                startNow,
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.tasks });
            toast(startNow ? 'Task created and started' : 'Task created', 'success');
            reset();
            onClose();
        },
    });

    const canSubmit = title.trim().length > 0 && prompt.trim().length > 0;

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="New task"
            subtitle="A prompt Bee Flow runs for you on a schedule. Results arrive in notifications."
            footer={
                <Button
                    label="Create task"
                    onPress={() => mutation.mutate()}
                    disabled={!canSubmit}
                    loading={mutation.isPending}
                    fullWidth
                    size="lg"
                />
            }
        >
            {mutation.isError ? (
                <Banner tone="error">{describeError(mutation.error).message}</Banner>
            ) : null}

            <TextField
                label="Name"
                value={title}
                onChangeText={setTitle}
                placeholder="Monday news digest"
                autoCapitalize="sentences"
                returnKeyType="next"
            />

            <TextField
                label="What should it do?"
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Summarise this week's industry news in five bullets."
                multiline
                maxLines={6}
                autoCapitalize="sentences"
                hint="Written as if you were asking in chat."
            />

            <WhenPicker value={when} onChange={setWhen} label="First run" />

            <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="secondary" weight="medium">
                    Repeat
                </Text>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
                >
                    <Chip
                        label={REPEAT_LABELS.once}
                        selected={repeat === null}
                        onPress={() => setRepeat(null)}
                    />
                    {REPEAT_INTERVALS.map((interval) => (
                        <Chip
                            key={interval}
                            label={REPEAT_LABELS[interval]}
                            selected={repeat === interval}
                            onPress={() => setRepeat(interval)}
                        />
                    ))}
                </ScrollView>
            </View>

            <Chip
                label={startNow ? 'Will also run right away' : 'Also run it right away'}
                selected={startNow}
                onPress={() => setStartNow((v) => !v)}
            />
        </Sheet>
    );
}
