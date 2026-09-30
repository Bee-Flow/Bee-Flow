/**
 * The shape of a Solution at a glance: one tile per kind with its count, so
 * "3 routines, 2 apps, 1 page" reads as one thing. A kind whose store could
 * not be read shows a dash — telling someone they have no routines when the
 * truth is "we could not ask" is the worse failure. Tapping a tile opens
 * Content, where the rows are.
 */

import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KIND_ICON, Text } from '@/shared/ui';

import { sectionCounts } from '../model/content';
import { SECTIONS, sectionLabel } from '../model/sections';
import type { ProjectResources } from '../model/types';

export function CountTiles({ resources, onOpen }: { resources: ProjectResources | null | undefined; onOpen: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const counts = sectionCounts(resources);
    return (
        <View style={styles.grid}>
            {counts.map(({ key, count }) => {
                const tile = SECTIONS.find((s) => s.key === key)?.tile;
                const label = sectionLabel(key, t);
                const value = count === null ? '—' : String(count);
                return (
                    <Pressable
                        key={key}
                        onPress={onOpen}
                        style={styles.tile}
                        accessibilityRole="button"
                        accessibilityLabel={`${label}: ${value}`}
                        testID={`count-${key}`}
                    >
                        <View style={styles.label}>
                            <Icon name={tile ? KIND_ICON[tile] : 'ShieldCheck'} size={14} color={styles.muted.color} />
                            <Text variant="label" tone="tertiary" numberOfLines={1}>
                                {label}
                            </Text>
                        </View>
                        <Text variant="title">{value}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
    tile: {
        flexBasis: '46%',
        flexGrow: 1,
        gap: theme.spacing.xs,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    label: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1.5] } satisfies ViewStyle,
    muted: { color: theme.colors.textTertiary },
});
