/**
 * Create a reminder, or move one that already exists.
 *
 * A reminder is the simplest thing on this tab: a title, a moment, and an
 * optional repeat. When the moment arrives a background checker writes a
 * notification (server/stores/reminderStore.js processDueReminders).
 *
 * The repeat options are exactly the three `advanceRemindAt` understands —
 * daily, weekly, monthly. Offering "every 2 weeks" here would store a string
 * the checker returns null for, which silently turns a repeating reminder into
 * a one-off. Better to offer three real choices than eight, one of which lies.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';

import { WhenPicker } from './WhenPicker';
import { useTheme } from '../../../theme/ThemeProvider';
import { Chip } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Banner, describeError } from '../../../ui/Feedback';
import { TextField } from '../../../ui/Input';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { useToast } from '../../../ui/Toast';
import { automateKeys, createReminder, snoozeReminder } from '../api';
import type { Reminder } from '../types';

const REPEATS: { value: string | null; label: string }[] = [
    { value: null, label: 'Once' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
];

export function ReminderSheet({
    visible,
    onClose,
    /** Passing one turns this into "move it" — the only edit a phone needs. */
    reschedule,
}: {
    visible: boolean;
    onClose: () => void;
    reschedule?: Reminder | null;
}) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const editing = Boolean(reschedule);

    const [title, setTitle] = useState('');
    const [message, setMessage] = useState('');
    const [repeat, setRepeat] = useState<string | null>(null);
    const [when, setWhen] = useState(() => defaultWhen());

    /**
     * Re-seed the form whenever the sheet opens, or opens for a different
     * reminder — otherwise reopening it shows the previous one's time.
     *
     * Adjusted DURING render rather than in an effect, which is React's own
     * recommendation for "a prop changed, so derived state must change": an
     * effect would paint the stale values for one frame first, and on a sheet
     * that slides in, that frame is visible.
     */
    const seed = visible ? (reschedule?.id ?? 'new') : 'closed';
    const [lastSeed, setLastSeed] = useState(seed);
    if (lastSeed !== seed) {
        setLastSeed(seed);
        setTitle(reschedule?.title ?? '');
        setMessage(reschedule?.message ?? '');
        setRepeat(reschedule?.repeatInterval ?? null);
        setWhen(reschedule?.remindAt ? new Date(reschedule.remindAt) : defaultWhen());
    }

    const mutation = useMutation({
        mutationFn: async () => {
            if (reschedule) {
                await snoozeReminder(reschedule.id, when.toISOString());
                return;
            }
            await createReminder({
                title: title.trim(),
                message: message.trim() || undefined,
                remindAt: when.toISOString(),
                repeatInterval: repeat,
            });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.reminders });
            toast(editing ? 'Reminder moved' : 'Reminder set', 'success');
            onClose();
        },
    });

    const canSubmit = editing || title.trim().length > 0;

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={editing ? 'Move reminder' : 'New reminder'}
            subtitle={editing ? reschedule?.title : 'Bee Flow will notify you when the time comes.'}
            footer={
                <Button
                    label={editing ? 'Move it' : 'Set reminder'}
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

            {!editing ? (
                <>
                    <TextField
                        label="Remind me to"
                        value={title}
                        onChangeText={setTitle}
                        placeholder="Send the quarterly report"
                        autoCapitalize="sentences"
                    />
                    <TextField
                        label="Notes"
                        value={message}
                        onChangeText={setMessage}
                        placeholder="Optional"
                        multiline
                        maxLines={4}
                        autoCapitalize="sentences"
                    />
                </>
            ) : null}

            <WhenPicker value={when} onChange={setWhen} label={editing ? 'Move to' : 'When'} />

            {!editing ? (
                <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="caption" tone="secondary" weight="medium">
                        Repeat
                    </Text>
                    <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                        {REPEATS.map((option) => (
                            <Chip
                                key={option.label}
                                label={option.label}
                                selected={repeat === option.value}
                                onPress={() => setRepeat(option.value)}
                            />
                        ))}
                    </View>
                </View>
            ) : null}
        </Sheet>
    );
}

/** The next round hour — nobody sets a reminder for 14:37. */
function defaultWhen(): Date {
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return next;
}
