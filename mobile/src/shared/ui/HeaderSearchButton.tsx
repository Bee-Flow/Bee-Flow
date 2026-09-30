/**
 * The header's "search everything" action: opens the global search screen.
 * A header accessory — app/_layout.tsx puts it into every ScreenHeader through
 * HeaderAccessoryProvider, before the notification bell.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { IconButton } from './IconButton';
import { Icon } from './icons/Icon';

export function HeaderSearchButton() {
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    return (
        <IconButton
            icon={<Icon name="Search" size={20} color={theme.colors.textSecondary} />}
            accessibilityLabel={t('mobile.ui.search_everything', 'Search everything')}
            onPress={() => router.push('/search')}
        />
    );
}
