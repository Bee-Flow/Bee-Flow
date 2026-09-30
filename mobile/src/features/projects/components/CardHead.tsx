/**
 * How a Solution card opens, in the catalogue and on the overview alike: the
 * tile, the name, one quiet line under it (the version, or the role and
 * source), and an optional chip at the end of the row.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { SolutionTile } from './SolutionTile';

export function CardHead({ icon, name, sub, end }: { icon: string | null | undefined; name: string; sub: string; end?: ReactNode }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.head}>
            <SolutionTile icon={icon} />
            <View style={styles.titles}>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                    {name}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {sub}
                </Text>
            </View>
            {end}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        head: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2.5] },
        titles: { flex: 1, minWidth: 0 },
    });
