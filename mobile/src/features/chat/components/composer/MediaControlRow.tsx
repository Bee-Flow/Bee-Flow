/** One setting of the media panel: a row of choices, a stepped number, or a switch. */

import React from 'react';
import { ScrollView, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { controlValue, type MediaControl } from '@/features/chat/model/mediaPanels';
import type { MediaValue } from '@/features/chat/model/mediaSettings';
import { Chip, Stepper, Text, ToggleRow } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    block: { gap: theme.spacing.xs },
    chips: { gap: theme.spacing[1.5] },
});

export function MediaControlRow({
    control,
    value,
    onChange,
}: {
    control: MediaControl;
    value: MediaValue | undefined;
    onChange: (next: MediaValue) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const shown = controlValue(control, value);
    const label = t(control.label.i18nKey, control.label.en);

    if (control.kind === 'switch') {
        return (
            <ToggleRow
                label={label}
                description={control.hint ? t(control.hint.i18nKey, control.hint.en) : undefined}
                value={shown === true}
                onValueChange={onChange}
                gutter={false}
            />
        );
    }
    if (control.kind === 'number') {
        const { min, max, step, unit } = control.spec;
        const decimals = step < 1 ? String(step).split('.')[1]?.length ?? 1 : 0;
        return (
            <Stepper
                label={label}
                value={Number(shown)}
                min={min}
                max={max}
                step={step}
                format={(n) => `${n.toFixed(decimals)}${unit ?? ''}`}
                onChange={onChange}
            />
        );
    }
    return (
        <View style={styles.block}>
            <Text variant="caption" tone="secondary">
                {label}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {control.options.map((option) => (
                    <Chip
                        key={String(option.value)}
                        label={option.i18nKey ? t(option.i18nKey, option.name) : option.name}
                        selected={option.value === shown}
                        onPress={() => onChange(option.value)}
                    />
                ))}
            </ScrollView>
        </View>
    );
}
