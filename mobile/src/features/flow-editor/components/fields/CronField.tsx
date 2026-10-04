/**
 * A schedule — the web's visual schedule builder (agent-hub
 * `Builder/flow/ScheduleBuilder.jsx`) over model/schedule.ts, its port: pick a
 * shape (every N minutes, hourly, daily, weekly, monthly), fill in the time,
 * and the cron is written for you. Anything that is not one of those shapes
 * is held in Custom and round-trips untouched; only strings the server's cron
 * grammar accepts are ever generated.
 *
 * The chosen shape is kept here, not re-derived from the cron on every render:
 * a Custom "0 9 * * *" reads as Daily, and the author who picked Custom to
 * type one must not be flipped out of it mid-sentence.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import {
    cronFromPreset,
    describeCron,
    presetFromCron,
    SCHEDULE_MODES,
    WEEKDAYS,
    weekdayLabel,
    type SchedulePreset,
} from '@/features/flow-editor/model';
import { Chip, TextField } from '@/shared/ui';

import { FieldRow } from './FieldRow';
import { NumberField } from './NumberField';
import { SelectField } from './SelectField';

type Loose = { mode: string } & Record<string, unknown>;

interface PartProps {
    preset: Loose;
    set: (patch: Record<string, unknown>) => void;
    disabled: boolean;
}

const MODE_WORDS: Record<(typeof SCHEDULE_MODES)[number], string> = {
    minute: 'Every few minutes',
    hourly: 'Every hour',
    daily: 'Every day',
    weekly: 'Every week',
    monthly: 'Every month',
    custom: 'Custom (cron)',
};

/** The shape switched to another mode, keeping the time where it has one. */
export function switchMode(preset: Loose, mode: string, currentCron: string): Loose {
    if (mode === 'custom') return { mode: 'custom', cron: currentCron };
    return { ...presetFromCron(cronFromPreset({ ...preset, mode })), mode };
}

function TimeRow({ preset, set, disabled }: PartProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.pair}>
            <View style={styles.half}>
                <NumberField label={t('mobile.flow.schedule.hour', 'Hour')} value={preset.hour ?? 9} min={0} max={23} integer onChange={(n) => set({ hour: n })} disabled={disabled} />
            </View>
            <View style={styles.half}>
                <NumberField label={t('mobile.flow.schedule.minute', 'Minute')} value={preset.minute ?? 0} min={0} max={59} integer onChange={(n) => set({ minute: n })} disabled={disabled} />
            </View>
        </View>
    );
}

function Weekdays({ days, onChange, disabled }: { days: number[]; onChange: (days: number[]) => void; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.days}>
            {WEEKDAYS.map((d) => {
                const on = days.includes(d.id);
                return (
                    <Chip
                        key={d.id}
                        label={weekdayLabel(d.id, t)}
                        selected={on}
                        onPress={() => onChange(on ? days.filter((x) => x !== d.id) : [...days, d.id])}
                        disabled={disabled}
                    />
                );
            })}
        </View>
    );
}

function ModeFields({ preset, set, disabled }: PartProps) {
    const t = useTranslation();
    switch (preset.mode) {
        case 'minute':
            return <NumberField label={t('mobile.flow.schedule.every_n', 'Every how many minutes')} value={preset.everyN ?? 1} min={1} max={59} integer onChange={(n) => set({ everyN: n })} disabled={disabled} />;
        case 'hourly':
            return <NumberField label={t('mobile.flow.schedule.at_minute', 'At minute')} value={preset.minute ?? 0} min={0} max={59} integer onChange={(n) => set({ minute: n })} disabled={disabled} />;
        case 'weekly':
            return (
                <>
                    <Weekdays days={Array.isArray(preset.days) ? (preset.days as number[]) : [1]} onChange={(days) => set({ days })} disabled={disabled} />
                    <TimeRow preset={preset} set={set} disabled={disabled} />
                </>
            );
        case 'monthly':
            return (
                <>
                    <NumberField label={t('automations.settings.day_of_month', 'Day of the month')} value={preset.day ?? 1} min={1} max={31} integer onChange={(n) => set({ day: n })} disabled={disabled} />
                    <TimeRow preset={preset} set={set} disabled={disabled} />
                </>
            );
        case 'custom':
            return (
                <TextField
                    label={t('mobile.flow.schedule.cron', 'Cron expression')}
                    value={String(preset.cron ?? '')}
                    onChangeText={(cron) => set({ cron })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!disabled}
                />
            );
        default:
            return <TimeRow preset={preset} set={set} disabled={disabled} />;
    }
}

export function CronField({
    value,
    onChange,
    label,
    hint,
    disabled = false,
    testID,
}: {
    value: string | null | undefined;
    onChange: (cron: string) => void;
    label?: string;
    hint?: string | null;
    disabled?: boolean;
    testID?: string;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const cron = value ?? '';
    const [preset, setPreset] = useState<Loose>(() => presetFromCron(cron) as SchedulePreset & Loose);
    const [seen, setSeen] = useState(cron);
    if (seen !== cron) {
        setSeen(cron);
        if (cronFromPreset(preset) !== cron) setPreset(presetFromCron(cron) as SchedulePreset & Loose);
    }
    const commit = (next: Loose) => {
        setPreset(next);
        const out = cronFromPreset(next);
        setSeen(out);
        if (out !== cron) onChange(out);
    };
    const options = SCHEDULE_MODES.map((m) => ({ value: m, label: t(`mobile.flow.schedule.mode_${m}`, MODE_WORDS[m]) }));
    return (
        <FieldRow label={label} hint={hint ?? describeCron(cronFromPreset(preset))} testID={testID}>
            <View style={styles.body}>
                <SelectField value={preset.mode} options={options} onChange={(mode) => commit(switchMode(preset, mode, cron))} disabled={disabled} />
                <ModeFields preset={preset} set={(patch) => commit({ ...preset, ...patch })} disabled={disabled} />
            </View>
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.md } satisfies ViewStyle,
    pair: { flexDirection: 'row', gap: theme.spacing.md } satisfies ViewStyle,
    half: { flex: 1 } satisfies ViewStyle,
    days: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[1.5] } satisfies ViewStyle,
});
