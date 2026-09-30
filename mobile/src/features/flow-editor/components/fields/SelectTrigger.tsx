/**
 * The closed face of a choice field: what is chosen (or the prompt, muted),
 * an optional accessory such as a sample value, and the chevron that says a
 * sheet opens. SelectField and the editors' FieldPicker both wear it, so a
 * choice looks and reads the same wherever it is made.
 */

import React, { type ReactNode } from 'react';
import { Pressable, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

export interface SelectTriggerProps {
    /** The chosen option's words, or the prompt. */
    shown: string;
    /** False while nothing is chosen: the words are then the prompt, muted. */
    chosen: boolean;
    onPress: () => void;
    label?: string;
    open?: boolean;
    disabled?: boolean;
    /** Between the words and the chevron. */
    accessory?: ReactNode;
    testID?: string;
}

export function SelectTrigger({ shown, chosen, onPress, label, open = false, disabled = false, accessory = null, testID }: SelectTriggerProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label ? `${label}: ${shown}` : shown}
            accessibilityState={{ disabled, expanded: open }}
            style={({ pressed }) => [styles.field, pressed ? styles.pressed : null, disabled ? styles.disabled : null]}
            testID={testID}
        >
            <Text variant="body" tone={chosen ? 'primary' : 'tertiary'} numberOfLines={1} style={styles.value}>
                {shown}
            </Text>
            {accessory}
            <Icon name="ChevronDown" size={18} color={styles.glyph.color} />
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        minHeight: theme.minTouch,
        paddingHorizontal: theme.spacing.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    disabled: { opacity: 0.5 } satisfies ViewStyle,
    value: { flex: 1 },
    glyph: { color: theme.colors.textTertiary },
});
