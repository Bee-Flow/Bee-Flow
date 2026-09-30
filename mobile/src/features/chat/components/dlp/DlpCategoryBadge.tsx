/** One kind of finding, in its group's colour — the web's DlpCategoryBadge in its compact form. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { categorySlot, categoryWords } from '@/features/chat/model/dlpCategories';
import { Text, tint } from '@/shared/ui';


const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

const makeStyles = (theme: Theme) => ({
    badge: {
        paddingHorizontal: theme.spacing[1.5],
        paddingVertical: theme.spacing.xxs,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
    },
    slot: SLOTS.map((i) => ({ borderColor: theme.pii[i], backgroundColor: tint(theme.pii[i], 22) })),
    ink: SLOTS.map((i) => ({ color: theme.pii[i] })),
});

export function DlpCategoryBadge({ category }: { category: string | undefined }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const slot = categorySlot(category);
    const words = categoryWords(category);
    const label = words ? t(words.i18nKey, words.en) : category === 'UserMarked' ? t('dlp.confidence_manual', 'Marked by you') : (category ?? '');
    return (
        <View style={[styles.badge, styles.slot[slot]]}>
            <Text variant="label" weight="medium" style={styles.ink[slot]} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}
