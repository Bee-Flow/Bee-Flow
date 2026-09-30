/**
 * Text entry.
 *
 * The label is a real <Text> above the field rather than a placeholder. A
 * placeholder-as-label disappears the moment someone types, which is exactly
 * when a form with six fields becomes unusable — and it is invisible to a
 * screen reader that reads the field after it has content.
 *
 * `error` renders inline and is announced; it is never a toast. A validation
 * message that floats away from the field it belongs to helps nobody.
 */

import React, { forwardRef, useState } from 'react';
import {
    Pressable,
    TextInput,
    View,
    type StyleProp,
    type TextInputProps,
    type ViewStyle,
} from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { fieldStyles as styles } from './fieldStyles';
import { Icon } from './icons/Icon';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
    label?: string;
    /** Shown under the field in the muted tone, above any error. */
    hint?: string;
    error?: string | null;
    /** Renders a show/hide toggle and turns off autocorrect + suggestions. */
    secure?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
    /** Grows with content, up to `maxLines`. For notes and prompts. */
    multiline?: boolean;
    maxLines?: number;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
    {
        label,
        hint,
        error,
        secure = false,
        containerStyle,
        multiline = false,
        maxLines = 6,
        onFocus,
        onBlur,
        ...rest
    },
    ref,
) {
    const theme = useTheme();
    const [focused, setFocused] = useState(false);
    const [revealed, setRevealed] = useState(false);

    // React Native 0.86 narrowed these to FocusEvent/BlurEvent; deriving the
    // parameter types from the props keeps this working across that change
    // rather than pinning a type name that moved.
    const handleFocus: NonNullable<TextInputProps['onFocus']> = (e) => {
        setFocused(true);
        onFocus?.(e);
    };
    const handleBlur: NonNullable<TextInputProps['onBlur']> = (e) => {
        setFocused(false);
        onBlur?.(e);
    };

    const borderColor = error ? theme.colors.error : focusColor(theme, focused);

    return (
        <View style={[{ gap: theme.spacing.xs }, containerStyle]}>
            {label ? (
                <Text variant="caption" tone="secondary" weight="medium">
                    {label}
                </Text>
            ) : null}

            <View
                style={[
                    styles.field,
                    {
                        borderColor,
                        borderRadius: theme.radii.md,
                        backgroundColor: theme.colors.bgCard,
                        minHeight: theme.minTouch,
                        paddingHorizontal: theme.spacing.md,
                    },
                ]}
            >
                <TextInput
                    ref={ref}
                    {...rest}
                    multiline={multiline}
                    secureTextEntry={secure && !revealed}
                    autoCorrect={secure ? false : rest.autoCorrect}
                    autoCapitalize={secure ? 'none' : rest.autoCapitalize}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                    placeholderTextColor={theme.colors.textTertiary}
                    // Android draws its own underline on top of our border.
                    underlineColorAndroid="transparent"
                    accessibilityLabel={rest.accessibilityLabel ?? label}
                    style={[
                        theme.type.body,
                        styles.input,
                        {
                            color: theme.colors.textPrimary,
                            paddingVertical: theme.spacing.md,
                            ...(multiline
                                ? { maxHeight: theme.type.body.lineHeight * maxLines + theme.spacing.xl }
                                : {}),
                        },
                    ]}
                    textAlignVertical={multiline ? 'top' : 'center'}
                />
                {secure ? <RevealToggle revealed={revealed} onToggle={() => setRevealed((v) => !v)} /> : null}
            </View>

            <Footnote error={error} hint={hint} />
        </View>
    );
});

function focusColor(theme: ReturnType<typeof useTheme>, focused: boolean): string {
    return focused ? theme.colors.accentPrimary : theme.colors.borderDefault;
}

/** The show/hide eye on a secure field. */
function RevealToggle({ revealed, onToggle }: { revealed: boolean; onToggle: () => void }) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onToggle}
            hitSlop={theme.hitSlop}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            style={{ paddingLeft: theme.spacing.sm }}
        >
            <Icon name={revealed ? 'EyeOff' : 'Eye'} size={18} color={theme.colors.textMuted} />
        </Pressable>
    );
}

/** The error (announced) or, failing that, the hint under a field. */
function Footnote({ error, hint }: { error?: string | null; hint?: string }) {
    if (error) {
        return (
            <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                {error}
            </Text>
        );
    }
    if (!hint) return null;
    return (
        <Text variant="caption" tone="tertiary">
            {hint}
        </Text>
    );
}
