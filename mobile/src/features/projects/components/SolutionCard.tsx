/**
 * One Solution on the overview — the web's SolutionCard.jsx: its tile, name
 * and role, the health chip, what it holds, and how it ran today. Every
 * decision was made in overview.ts; this only lays it out.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Text } from '@/shared/ui';

import { CardHead } from './CardHead';
import { CountChips, HealthChip, RunLine, subLine, UpdateChip } from './SolutionCardParts';
import type { SolutionRow } from '../model/solution';

export function SolutionCard({ row, onOpen }: { row: SolutionRow; onOpen: (row: SolutionRow) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Card onPress={() => onOpen(row)} accessibilityLabel={row.name} testID={`solution-card-${row.id}`}>
            <View style={styles.stack}>
                <CardHead icon={row.icon} name={row.name} sub={subLine(row, t)} end={<HealthChip row={row} />} />
                <CountChips row={row} />
                {row.description ? (
                    <Text variant="caption" tone="secondary" numberOfLines={2}>
                        {row.description}
                    </Text>
                ) : null}
                <View style={styles.foot}>
                    <RunLine row={row} />
                    <UpdateChip row={row} />
                </View>
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stack: { gap: theme.spacing[2.5] },
        foot: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.spacing.sm, rowGap: theme.spacing.xs },
    });
