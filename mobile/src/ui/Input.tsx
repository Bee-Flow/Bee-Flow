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

import { Feather } from '@expo/vector-icons';
import React, { forwardRef, useState } from 'react';
import {
    Pressable,
    StyleSheet,
    TextInput,
    View,
    type StyleProp,
    type TextInputProps,
    type ViewStyle,
} from 'react-native';

import { Text } from './Text';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';


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

    const borderColor = error
        ? theme.colors.error
        : focused
          ? theme.colors.accentPrimary
          : theme.colors.borderDefault;

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
                {secure ? (
                    <Pressable
                        onPress={() => setRevealed((v) => !v)}
                        hitSlop={theme.hitSlop}
                        accessibilityRole="button"
                        accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
                        style={{ paddingLeft: theme.spacing.sm }}
                    >
                        <Feather
                            name={revealed ? 'eye-off' : 'eye'}
                            size={18}
                            color={theme.colors.textMuted}
                        />
                    </Pressable>
                ) : null}
            </View>

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
});

/**
 * The search field used above every list. Debouncing is the caller's job — the
 * field reports every keystroke, because some lists filter locally and want
 * them all.
 */
export function SearchField({
    value,
    onChangeText,
    placeholder = 'Search',
    autoFocus = false,
    onSubmit,
    style,
}: {
    value: string;
    onChangeText: (v: string) => void;
    placeholder?: string;
    autoFocus?: boolean;
    onSubmit?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <View
            style={[
                styles.field,
                {
                    borderRadius: theme.radii.pill,
                    backgroundColor: theme.colors.bgTertiary,
                    borderColor: 'transparent',
                    paddingHorizontal: theme.spacing.md,
                    minHeight: 44,
                },
                style,
            ]}
        >
            <Feather name="search" size={16} color={theme.colors.textMuted} />
            <TextInput
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.textTertiary}
                autoFocus={autoFocus}
                returnKeyType="search"
                onSubmitEditing={onSubmit}
                accessibilityLabel={placeholder}
                underlineColorAndroid="transparent"
                style={[
                    theme.type.body,
                    styles.input,
                    { color: theme.colors.textPrimary, marginLeft: theme.spacing.sm },
                ]}
            />
            {value.length > 0 ? (
                <Pressable
                    onPress={() => onChangeText('')}
                    hitSlop={theme.hitSlop}
                    accessibilityRole="button"
                    accessibilityLabel={t('mobile.ui.clear_search', 'Clear search')}
                >
                    <Feather name="x" size={16} color={theme.colors.textMuted} />
                </Pressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: StyleSheet.hairlineWidth,
    },
    input: { flex: 1, padding: 0 },
});
