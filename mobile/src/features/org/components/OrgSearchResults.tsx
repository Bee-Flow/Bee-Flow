/**
 * The index's search answer: every organisation screen that matches, the
 * deeper ones included, as the sitemap labels them. Replaces the groups while
 * a search is typed.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { Destination } from '@/features/sitemap';
import { openRoute } from '@/shared/navigation';
import { Group, Icon, ListRow, NoteRow } from '@/shared/ui';

export function OrgSearchResults({ places }: { places: readonly Destination[] }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <Group title={t('mobile.org.search_results', 'Organisation screens')}>
            {places.length === 0 ? <NoteRow>{t('common.no_results', 'No results found')}</NoteRow> : null}
            {places.map((place) => (
                <ListRow
                    key={place.id}
                    testID={`org-place-${place.id}`}
                    title={place.i18nKey ? t(place.i18nKey, place.label) : place.label}
                    subtitle={place.hint}
                    leading={<Icon name={place.icon} size={18} color={theme.colors.textMuted} />}
                    onPress={() => openRoute(router, place.href)}
                />
            ))}
        </Group>
    );
}
