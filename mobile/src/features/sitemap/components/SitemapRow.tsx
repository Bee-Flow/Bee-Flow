/** One row of the A–Z map, labelled in the reader's language where it can be. */

import { useRouter } from 'expo-router';
import React from 'react';
import { Linking } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { Icon, ListRow } from '@/shared/ui';

import type { Destination } from '../nav/types';

export function SitemapRow({ destination }: { destination: Destination }) {
    const theme = useTheme();
    const router = useRouter();
    const t = useTranslation();
    const { i18nKey, hintKey, label, hint, icon, external, href } = destination;
    return (
        <ListRow
            title={i18nKey ? t(i18nKey, label) : label}
            subtitle={hintKey ? t(hintKey, hint) : hint}
            leading={<Icon name={icon} size={18} color={theme.colors.textMuted} />}
            trailing={
                external ? (
                    <Icon name="ExternalLink" size={14} color={theme.colors.textMuted} />
                ) : undefined
            }
            onPress={() => {
                if (external) void Linking.openURL(href);
                // A tab (/, /cowork, /studio, /record) is switched to rather
                // than stacked as a second copy of the drawer (openRoute).
                else openRoute(router, href);
            }}
        />
    );
}
