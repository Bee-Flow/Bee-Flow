/** One "Waiting for you" entry on the Cowork hub: the title of the work, what it waits for, a tap to act on it. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow } from '@/shared/ui';

import { needRoute, needSentence } from '../model/needs';
import type { CoworkNeed } from '../model/types';

export function NeedsYouRow({ need }: { need: CoworkNeed }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={need.title || t('cowork_needs.untitled', 'Untitled work')}
            subtitle={needSentence(need, t)}
            leading={<Icon name={need.kind === 'decision' ? 'Clock' : 'Bell'} size={16} color={theme.colors.warningInk} />}
            onPress={() => router.push(needRoute(need))}
        />
    );
}
