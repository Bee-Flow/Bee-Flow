/**
 * A duration stored in seconds and shown in the unit it reads best in — the
 * web's Wait editor (agent-hub `Builder/flow/settings/collectionEditors.jsx`
 * WaitFields), with model/waitDuration.ts as the one vocabulary, so the step
 * card and this field never disagree ("2 hours", not "7200s").
 *
 * The unit is chosen once, when the field opens, and switching it keeps the
 * NUMBER on screen and re-reads it (5 seconds → 5 minutes) instead of
 * rescaling it into a 0.08 below the field's own minimum. The typed text wins
 * while it is being edited; a blank or nonsense entry falls back to the stored
 * value when the field is left.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { clampWaitSeconds, WAIT_UNIT_FACTOR, waitUnitFor, type WaitUnit } from '@/features/flow-editor/model';
import { Segmented, TextField } from '@/shared/ui';

import { FieldRow } from './FieldRow';

/** The number shown for `seconds` in `unit`, to two decimals. */
export function durationDisplay(seconds: number, unit: WaitUnit): string {
    return String(Math.round((seconds / WAIT_UNIT_FACTOR[unit]) * 100) / 100);
}

/** Typed text in a unit → seconds, or null when it is not a positive number yet. */
export function durationSeconds(raw: string, unit: WaitUnit): number | null {
    const n = Number(String(raw).trim().replace(',', '.'));
    if (!String(raw).trim() || !Number.isFinite(n) || n <= 0) return null;
    return clampWaitSeconds(n * WAIT_UNIT_FACTOR[unit]);
}

export function DurationField({
    value,
    onChange,
    label,
    hint,
    required,
    error,
    disabled = false,
    testID,
}: {
    value: unknown;
    onChange: (seconds: number) => void;
    label?: string;
    hint?: string | null;
    required?: boolean;
    error?: string | null;
    disabled?: boolean;
    testID?: string;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const seconds = clampWaitSeconds(Number(value ?? 5) || 5);
    const [unit, setUnit] = useState<WaitUnit>(() => waitUnitFor(seconds));
    const [typed, setTyped] = useState<string | null>(null);
    const display = typed ?? durationDisplay(seconds, unit);

    const onText = (raw: string) => {
        setTyped(raw);
        const next = durationSeconds(raw, unit);
        if (next !== null) onChange(next);
    };
    const onUnit = (next: WaitUnit) => {
        setUnit(next);
        setTyped(null);
        const n = durationSeconds(display, next);
        if (n !== null) onChange(n);
    };

    return (
        <FieldRow label={label} hint={hint} required={required} error={error} testID={testID}>
            <View style={styles.row}>
                <TextField
                    value={display}
                    onChangeText={onText}
                    onBlur={() => setTyped(null)}
                    editable={!disabled}
                    keyboardType="decimal-pad"
                    accessibilityLabel={t('mobile.flow.wait.duration', 'Wait duration')}
                    containerStyle={styles.input}
                    testID={testID ? `${testID}-input` : undefined}
                />
                <Segmented
                    value={unit}
                    onChange={onUnit}
                    accessibilityLabel={t('mobile.flow.wait.unit', 'Duration unit')}
                    options={[
                        { value: 'seconds', label: t('mobile.flow.wait.seconds', 'seconds'), disabled },
                        { value: 'minutes', label: t('automations.settings.minutes', 'minutes'), disabled },
                        { value: 'hours', label: t('mobile.flow.wait.hours', 'hours'), disabled },
                    ]}
                />
            </View>
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    input: { flex: 1, minWidth: 64 } satisfies ViewStyle,
});
