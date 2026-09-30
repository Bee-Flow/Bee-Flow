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

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Chip, Sheet, Text, TextField, useToast } from '@/shared/ui';

import { WhenPicker } from './WhenPicker';
import { useSaveReminder } from '../hooks/mutations';
import type { Reminder } from '../model/types';

const REPEATS: { value: string | null; label: string }[] = [
    { value: null, label: 'Once' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
];

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        group: { gap: theme.spacing.sm },
        chips: { flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' },
    });

/** The next round hour — nobody sets a reminder for 14:37. */
function defaultWhen(): Date {
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return next;
}

function RepeatChoice({ value, onChange }: { value: string | null; onChange: (next: string | null) => void }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.group}>
            <Text variant="caption" tone="secondary" weight="medium">
                Repeat
            </Text>
            <View style={styles.chips}>
                {REPEATS.map((option) => (
                    <Chip
                        key={option.label}
                        label={option.label}
                        selected={value === option.value}
                        onPress={() => onChange(option.value)}
                    />
                ))}
            </View>
        </View>
    );
}

/**
 * The form's fields, re-seeded whenever the sheet opens, or opens for a
 * different reminder — otherwise reopening it shows the previous one's time.
 *
 * Adjusted DURING render rather than in an effect, which is React's own
 * recommendation for "a prop changed, so derived state must change": an
 * effect would paint the stale values for one frame first, and on a sheet
 * that slides in, that frame is visible.
 */
function useReminderDraft(visible: boolean, reschedule: Reminder | null | undefined) {
    const [title, setTitle] = useState('');
    const [message, setMessage] = useState('');
    const [repeat, setRepeat] = useState<string | null>(null);
    const [when, setWhen] = useState(() => defaultWhen());

    const seed = visible ? (reschedule?.id ?? 'new') : 'closed';
    const [lastSeed, setLastSeed] = useState(seed);
    if (lastSeed !== seed) {
        setLastSeed(seed);
        setTitle(reschedule?.title ?? '');
        setMessage(reschedule?.message ?? '');
        setRepeat(reschedule?.repeatInterval ?? null);
        setWhen(reschedule?.remindAt ? new Date(reschedule.remindAt) : defaultWhen());
    }
    return { title, setTitle, message, setMessage, repeat, setRepeat, when, setWhen };
}

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
    const { toast } = useToast();
    const editing = Boolean(reschedule);
    const draft = useReminderDraft(visible, reschedule);

    const mutation = useSaveReminder(reschedule, {
        onSuccess: () => {
            toast(editing ? 'Reminder moved' : 'Reminder set', 'success');
            onClose();
        },
    });
    const submit = () =>
        mutation.mutate({
            title: draft.title,
            message: draft.message,
            remindAt: draft.when.toISOString(),
            repeatInterval: draft.repeat,
        });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={editing ? 'Move reminder' : 'New reminder'}
            subtitle={editing ? reschedule?.title : 'Bee Flow will notify you when the time comes.'}
            footer={
                <Button
                    label={editing ? 'Move it' : 'Set reminder'}
                    onPress={submit}
                    disabled={!(editing || draft.title.trim().length > 0)}
                    loading={mutation.isPending}
                    fullWidth
                    size="lg"
                />
            }
        >
            {mutation.isError ? <Banner tone="error">{describeError(mutation.error).message}</Banner> : null}

            {!editing ? (
                <>
                    <TextField
                        label="Remind me to"
                        value={draft.title}
                        onChangeText={draft.setTitle}
                        placeholder="Send the quarterly report"
                        autoCapitalize="sentences"
                    />
                    <TextField
                        label="Notes"
                        value={draft.message}
                        onChangeText={draft.setMessage}
                        placeholder="Optional"
                        multiline
                        maxLines={4}
                        autoCapitalize="sentences"
                    />
                </>
            ) : null}

            <WhenPicker value={draft.when} onChange={draft.setWhen} label={editing ? 'Move to' : 'When'} />

            {!editing ? <RepeatChoice value={draft.repeat} onChange={draft.setRepeat} /> : null}
        </Sheet>
    );
}
