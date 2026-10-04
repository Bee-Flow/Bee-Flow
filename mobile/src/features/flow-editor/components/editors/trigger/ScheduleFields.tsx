/**
 * A schedule trigger: the schedule, its timezone, and the next firing times
 * as the SERVER computes them (POST /api/automation/_schedule/preview, the
 * scheduler's own `nextRunAt`) — the web's ScheduleBuilder. Like the web
 * builder, a trigger with no cron yet is given the default one the moment
 * the band opens, so a schedule trigger never saves empty.
 */

import React, { useEffect, useRef } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useSchedulePreview, type SchedulePreview } from '@/features/automations';
import { CronField, SelectField } from '@/features/flow-editor/components/fields';
import { cronFromPreset, presetFromCron, timezoneOptions } from '@/features/flow-editor/model';
import { Icon, Spinner, Text } from '@/shared/ui';

import { useSettled } from '../shared/useSettled';
import type { StepEditorProps } from '../types';

export const DEFAULT_TZ = 'Europe/Amsterdam';

/** An instant as the schedule's own zone reads it; the device's reading when the engine has no such zone. */
export function formatInZone(iso: string, tz: string): string {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return iso;
    try {
        return when.toLocaleString(undefined, { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return when.toLocaleString();
    }
}

function NextRuns({ preview, fetching, tz }: { preview: SchedulePreview | null | undefined; fetching: boolean; tz: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (preview && !preview.valid) {
        return (
            <Text variant="caption" tone="error">
                {preview.error || t('mobile.flow.schedule.unreadable', 'The server could not read that schedule.')}
            </Text>
        );
    }
    const next = preview?.valid ? preview.next : [];
    return (
        <View style={styles.runs}>
            <Text variant="caption" tone="tertiary">
                {t('mobile.flow.schedule.next_runs_in', 'Next runs in {tz}:', { tz })}
            </Text>
            {fetching && !next.length ? <Spinner /> : null}
            {next.map((iso, i) => (
                <View key={`${iso}-${i}`} style={styles.run}>
                    <Icon name="Clock" size={14} color={styles.glyph.color} />
                    <Text variant="caption">{formatInZone(iso, tz)}</Text>
                </View>
            ))}
            {!fetching && preview?.valid && !next.length ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.schedule.none_upcoming', 'No upcoming runs in the next year.')}
                </Text>
            ) : null}
        </View>
    );
}

export function ScheduleFields({ draft, setMany, ctx }: StepEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const cron = typeof draft.scheduleCron === 'string' ? draft.scheduleCron : '';
    const tz = typeof draft.scheduleTz === 'string' && draft.scheduleTz ? draft.scheduleTz : DEFAULT_TZ;
    const settledCron = useSettled(cron);
    const settledTz = useSettled(tz);
    const preview = useSchedulePreview(settledCron, settledTz);

    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || cron || ctx.disabled) return;
        seeded.current = true;
        setMany({ scheduleCron: cronFromPreset(presetFromCron('')), scheduleTz: tz });
    });

    const zones = timezoneOptions();
    const options = (zones.includes(tz) ? zones : [tz, ...zones]).map((z) => ({ value: z, label: z }));
    return (
        <>
            <CronField
                label={t('mobile.flow.schedule.frequency', 'Frequency')}
                value={cron}
                onChange={(next) => setMany({ scheduleCron: next, scheduleTz: tz })}
                disabled={ctx.disabled}
                testID="trigger-cron"
            />
            <SelectField
                label={t('automation_editor.trigger.timezone', 'Timezone')}
                value={tz}
                options={options}
                onChange={(next) => setMany({ scheduleCron: cron, scheduleTz: next })}
                disabled={ctx.disabled}
                testID="trigger-tz"
            />
            <View style={styles.box} accessibilityLiveRegion="polite">
                {settledCron ? <NextRuns preview={preview.data} fetching={preview.isFetching} tz={settledTz} /> : null}
            </View>
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { padding: theme.spacing.md, borderRadius: theme.radii.md, backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    runs: { gap: theme.spacing.xs } satisfies ViewStyle,
    run: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
});
