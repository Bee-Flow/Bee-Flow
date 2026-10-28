/**
 * Create a scheduled AI task ("automation").
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

import React, { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type TextInput } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Chip, Sheet, Text, TextField, useToast } from '@/shared/ui';

import { WhenPicker } from './WhenPicker';
import { useCreateTask } from '../hooks/mutations';
import { REPEAT_INTERVALS, type RepeatInterval } from '../model/types';

/** The labels travel as data; the chips render them through t(). */
const REPEAT_LABELS: Record<RepeatInterval | 'once', { i18nKey: string; en: string }> = {
    once: { i18nKey: 'cowork.repeat.once', en: 'Once' },
    hourly: { i18nKey: 'automations.cadence_hourly', en: 'Hourly' },
    daily: { i18nKey: 'automations.cadence_daily', en: 'Daily' },
    weekdays: { i18nKey: 'automations.repeating.cadenceWeekdays', en: 'Weekdays' },
    weekly: { i18nKey: 'automations.cadence_weekly', en: 'Weekly' },
    biweekly: { i18nKey: 'cowork.repeat.biweekly', en: 'Every 2 weeks' },
    monthly: { i18nKey: 'automations.cadence_monthly', en: 'Monthly' },
    quarterly: { i18nKey: 'mobile.tasks.repeat_quarterly', en: 'Every 3 months' },
    yearly: { i18nKey: 'mobile.tasks.repeat_yearly', en: 'Yearly' },
};

const repeatLabel = (t: TranslateFn, key: RepeatInterval | 'once') => t(REPEAT_LABELS[key].i18nKey, REPEAT_LABELS[key].en);

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        group: { gap: theme.spacing.sm },
        chips: { gap: theme.spacing.sm, paddingRight: theme.spacing.lg },
    });

export function TaskSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();

    const [title, setTitle] = useState('');
    const [prompt, setPrompt] = useState('');
    const promptField = useRef<TextInput>(null);
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

    const mutation = useCreateTask({
        onSuccess: () => {
            toast(startNow ? t('mobile.tasks.created_started', 'Task created and started') : t('mobile.tasks.created', 'Task created'), 'success');
            reset();
            onClose();
        },
    });
    const submit = () =>
        mutation.mutate({
            title: title.trim(),
            prompt: prompt.trim(),
            nextRunAt: when.toISOString(),
            repeatInterval: repeat,
            // The device's own zone, so "every day at 09:00" means 09:00
            // where the person is, not where the server happens to run.
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            startNow,
        });

    const canSubmit = title.trim().length > 0 && prompt.trim().length > 0;

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.tasks.new_task', 'New task')}
            subtitle={t('mobile.tasks.sheet_subtitle', 'A prompt Bee Flow runs for you on a schedule. Results arrive in notifications.')}
            footer={
                <Button
                    label={t('mobile.tasks.create', 'Create task')}
                    onPress={submit}
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
                label={t('common.name', 'Name')}
                value={title}
                onChangeText={setTitle}
                placeholder={t('mobile.tasks.name_placeholder', 'Monday news digest')}
                autoCapitalize="sentences"
                // Next moves on to the prompt, keeping the keyboard up. The
                // prompt is multi-line, so its return key is a new line.
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => promptField.current?.focus()}
            />

            <TextField
                ref={promptField}
                label={t('mobile.tasks.prompt_label', 'What should it do?')}
                value={prompt}
                onChangeText={setPrompt}
                placeholder={t('mobile.tasks.prompt_placeholder', "Summarise this week's industry news in five bullets.")}
                multiline
                maxLines={6}
                autoCapitalize="sentences"
                hint={t('mobile.tasks.prompt_hint', 'Written as if you were asking in chat.')}
            />

            <WhenPicker value={when} onChange={setWhen} label={t('mobile.tasks.first_run', 'First run')} />

            <View style={styles.group}>
                <Text variant="caption" tone="secondary" weight="medium">
                    {t('automations.repeat', 'Repeat')}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                    <Chip
                        label={repeatLabel(t, 'once')}
                        selected={repeat === null}
                        onPress={() => setRepeat(null)}
                    />
                    {REPEAT_INTERVALS.map((interval) => (
                        <Chip
                            key={interval}
                            label={repeatLabel(t, interval)}
                            selected={repeat === interval}
                            onPress={() => setRepeat(interval)}
                        />
                    ))}
                </ScrollView>
            </View>

            <Chip
                label={startNow ? t('mobile.tasks.also_now_on', 'Will also run right away') : t('mobile.tasks.also_now', 'Also run it right away')}
                selected={startNow}
                onPress={() => setStartNow((v) => !v)}
            />
        </Sheet>
    );
}
