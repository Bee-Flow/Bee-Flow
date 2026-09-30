/**
 * A six-box entry for a numeric code.
 *
 * Not in the shared kit because nothing else in the app takes a fixed-length
 * code: TextField is the right control for every other field, and it
 * deliberately does not expose the input's `style`, so a centred, letter-spaced
 * variant cannot be built out of it.
 *
 * The boxes are cosmetic. One real <TextInput> sits invisibly on top of them
 * and owns the value, the keyboard, the paste menu and Android's one-time-code
 * autofill; the boxes are hidden from the accessibility tree so a screen reader
 * hears a single "six-digit code" field rather than six empty ones.
 */

import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

export interface CodeFieldProps {
    value: string;
    onChangeText: (value: string) => void;
    length?: number;
    autoFocus?: boolean;
    editable?: boolean;
    accessibilityLabel?: string;
    /** Fired when the last box is filled — usually the caller's submit. */
    onComplete?: (value: string) => void;
}

export function CodeField({
    value,
    onChangeText,
    length = 6,
    autoFocus = false,
    editable = true,
    accessibilityLabel,
    onComplete,
}: CodeFieldProps) {
    const theme = useTheme();
    const t = useTranslation();
    const input = useRef<TextInput>(null);
    const [focused, setFocused] = useState(false);

    const digits = value.split('');

    const handleChange = (next: string) => {
        const cleaned = next.replace(/\D/g, '').slice(0, length);
        onChangeText(cleaned);
        if (cleaned.length === length) onComplete?.(cleaned);
    };

    return (
        <Pressable
            onPress={() => input.current?.focus()}
            accessible={false}
            style={{ minHeight: 64, justifyContent: 'center' }}
        >
            <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ flexDirection: 'row', gap: theme.spacing.sm }}
            >
                {Array.from({ length }, (_, i) => {
                    const filled = digits[i] !== undefined;
                    // The "next empty box" gets the accent, so the caret is
                    // visible even though the real input is not.
                    const active = focused && i === Math.min(value.length, length - 1);
                    return (
                        <View
                            key={i}
                            style={{
                                flex: 1,
                                height: 60,
                                borderRadius: theme.radii.md,
                                borderWidth: active ? 2 : StyleSheet.hairlineWidth,
                                borderColor: active
                                    ? theme.colors.accentPrimary
                                    : theme.colors.borderDefault,
                                backgroundColor: theme.colors.bgCard,
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: editable ? 1 : 0.5,
                            }}
                        >
                            <Text variant="heading">{filled ? digits[i] : ''}</Text>
                        </View>
                    );
                })}
            </View>

            <TextInput
                ref={input}
                value={value}
                onChangeText={handleChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                keyboardType="number-pad"
                inputMode="numeric"
                // Android reads the code out of the SMS/notification shade when
                // the field is named this way; it costs nothing and saves a
                // switch to another app at the worst possible moment.
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={length}
                autoFocus={autoFocus}
                editable={editable}
                caretHidden
                underlineColorAndroid="transparent"
                accessibilityLabel={accessibilityLabel ?? t('mobile.onboarding.six_digit_code', 'Six-digit code')}
                style={[StyleSheet.absoluteFill, styles.hidden]}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    // Transparent rather than absent: the input must stay hittable and
    // focusable, and `opacity: 0` keeps it in the layout without painting.
    hidden: { opacity: 0, fontSize: 1 },
});
