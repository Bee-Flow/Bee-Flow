/**
 * The web rail's "Search… ⌘K" row, as a phone draws it: something that looks
 * like a search field and opens Studio search, so the hub's header keeps the
 * one global magnifier and the bell.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

export function SearchEntry() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    return (
        <Pressable
            onPress={() => router.push('/studio/search')}
            accessibilityRole="search"
            accessibilityLabel={t('studio.search.title', 'Search Studio')}
            style={({ pressed }) => [styles.field, pressed ? styles.pressed : null]}
            testID="studio-search-entry"
        >
            <Icon name="Search" size={14} color={theme.colors.textTertiary} />
            <Text variant="caption" tone="tertiary">
                {t('studio.search.placeholder', 'Search Studio…')}
            </Text>
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2],
        minHeight: 40,
        paddingHorizontal: theme.spacing[3],
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.bgTertiary,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
});
