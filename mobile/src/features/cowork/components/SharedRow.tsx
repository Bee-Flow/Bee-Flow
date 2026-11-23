/** One item shared with the caller on the Cowork hub: whose it is and what the caller may do with it. */

import { useRouter } from 'expo-router';
import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow } from '@/shared/ui';

import { sharedLine, sharedRoute } from '../model/shared';
import type { SharedItem } from '../model/types';

export function SharedRow({ item }: { item: SharedItem }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={item.title || t('cowork_needs.untitled', 'Untitled work')}
            subtitle={sharedLine(item, t)}
            meta={item.lastRunAt ? timeAgo(item.lastRunAt) : undefined}
            leading={<Icon name="Users" size={16} color={theme.colors.textMuted} />}
            onPress={() => router.push(sharedRoute(item.id))}
        />
    );
}
