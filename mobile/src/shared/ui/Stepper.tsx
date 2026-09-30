/**
 * A bounded number with − and + (a TTL in seconds, a percentage, a threshold).
 * The phone's stand-in for the web's range sliders: exact, reachable with one
 * thumb, and readable by TalkBack as an adjustable value.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { IconButton } from './IconButton';
import { Icon } from './icons/Icon';
import { Text } from './Text';

export interface StepperProps {
    label: string;
    value: number;
    onChange: (next: number) => void;
    min: number;
    max: number;
    step?: number;
    /** How the value is written, e.g. `(v) => `${v}%``. */
    format?: (value: number) => string;
    disabled?: boolean;
    testID?: string;
}

export interface StepBounds {
    min: number;
    max: number;
    step?: number;
}

/** `value + delta`, snapped to the step grid from `min` and clamped. Pure; tested. */
export function stepValue(value: number, delta: number, { min, max, step = 1 }: StepBounds): number {
    const snapped = Math.round((value + delta - min) / step) * step + min;
    const fixed = Number(snapped.toFixed(6));
    return Math.min(max, Math.max(min, fixed));
}

export function Stepper({ label, value, onChange, min, max, step = 1, format, disabled = false, testID }: StepperProps) {
    const t = useTranslation();
    const theme = useTheme();
    const bounds = { min, max, step };
    const shown = format ? format(value) : String(value);
    const glyph = (name: 'Minus' | 'Plus') => <Icon name={name} size={16} color={theme.colors.textPrimary} />;
    return (
        <View
            testID={testID}
            style={styles.row}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={label}
            accessibilityValue={{ text: shown, min, max, now: value }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) =>
                onChange(stepValue(value, e.nativeEvent.actionName === 'increment' ? step : -step, bounds))
            }
        >
            <Text variant="body" style={styles.label}>
                {label}
            </Text>
            <IconButton
                icon={glyph('Minus')}
                accessibilityLabel={t('mobile.ui.stepper_less', 'Less')}
                disabled={disabled || value <= min}
                onPress={() => onChange(stepValue(value, -step, bounds))}
            />
            <Text variant="body" style={styles.value}>
                {shown}
            </Text>
            <IconButton
                icon={glyph('Plus')}
                accessibilityLabel={t('mobile.ui.stepper_more', 'More')}
                disabled={disabled || value >= max}
                onPress={() => onChange(stepValue(value, step, bounds))}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
    label: { flex: 1 },
    value: { minWidth: 64, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
