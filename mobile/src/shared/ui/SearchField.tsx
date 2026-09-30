/**
 * The search field used above every list. Debouncing is the caller's job — the
 * field reports every keystroke, because some lists filter locally and want
 * them all.
 */

import React from 'react';
import { Pressable, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { fieldStyles as styles } from './fieldStyles';
import { Icon } from './icons/Icon';

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
            <Icon name="Search" size={16} color={theme.colors.textMuted} />
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
                    accessibilityLabel={t('routines.mapping.clear_search', 'Clear search')}
                >
                    <Icon name="X" size={16} color={theme.colors.textMuted} />
                </Pressable>
            ) : null}
        </View>
    );
}
