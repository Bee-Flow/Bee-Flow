/**
 * One labelled row of a step's settings — the web's FormRow (agent-hub
 * `Builder/flow/settings/formPrimitives.jsx`): the label, a "Required" chip
 * where the validator blocks on the field (an asterisk is a developer
 * convention, not universal knowledge), the control, then the hint and any
 * error under it. The error is announced; it never floats away as a toast.
 */

import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, tint } from '@/shared/ui';

export interface FieldRowProps {
    label?: string;
    hint?: string | null;
    required?: boolean;
    error?: string | null;
    /** Something beside the label (a mode switch, a count). */
    accessory?: ReactNode;
    children: ReactNode;
    testID?: string;
}

export function FieldRow({ label, hint, required = false, error, accessory, children, testID }: FieldRowProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.row} testID={testID}>
            {label || accessory ? (
                <View style={styles.head}>
                    {label ? (
                        <Text variant="caption" tone="secondary" weight="medium" style={styles.label}>
                            {label}
                        </Text>
                    ) : null}
                    {required ? (
                        <View style={styles.required}>
                            <Text variant="label" tone="error">
                                {t('mobile.flow.field.required', 'Required')}
                            </Text>
                        </View>
                    ) : null}
                    {accessory}
                </View>
            ) : null}
            {children}
            {error ? (
                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                    {error}
                </Text>
            ) : hint ? (
                <Text variant="caption" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { gap: theme.spacing.xs } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1.5] } satisfies ViewStyle,
    label: { flexShrink: 1 },
    required: {
        paddingHorizontal: theme.spacing[1.5],
        borderRadius: theme.radii.pill,
        backgroundColor: tint(theme.colors.error, 12),
    } satisfies ViewStyle,
});
