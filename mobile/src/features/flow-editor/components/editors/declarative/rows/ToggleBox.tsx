/**
 * A step option that stays off until it is switched on — "Run once per item",
 * "Try again if this step fails": a bordered box whose switch reveals the
 * option's fields, with an optional line between the two (what the option
 * would do over the sample).
 */

import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ToggleField } from '@/features/flow-editor/components/fields';

export function ToggleBox({
    on,
    onToggle,
    label,
    description,
    disabled,
    status,
    children,
}: {
    on: boolean;
    onToggle: (on: boolean) => void;
    label: string;
    description: string;
    disabled?: boolean;
    status?: ReactNode;
    children: ReactNode;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.box}>
            <ToggleField value={on} onChange={onToggle} disabled={disabled} label={label} description={description} />
            {status}
            {on ? <View style={styles.fields}>{children}</View> : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: {
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    fields: { gap: theme.spacing.md } satisfies ViewStyle,
});
