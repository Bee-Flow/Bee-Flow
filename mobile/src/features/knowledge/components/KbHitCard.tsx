/**
 * One retrieved passage.
 *
 * The score is shown as a bar relative to the best hit in the same result set,
 * never as a percentage: it is a reciprocal-rank fusion score from
 * searchLocally (server/core/kb/localKBIngest.js), comparable within one query
 * and meaningless as an absolute. A "68% match" badge would be invented.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import { condense, relativeScore } from '../model/format';
import type { KbSearchHit } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        card: {
            borderRadius: theme.radii.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgCard,
            padding: theme.spacing.md,
            gap: theme.spacing.sm,
        },
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        source: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
        grow: { flex: 1 },
        track: { height: 3, borderRadius: 2, backgroundColor: theme.colors.bgTertiary, overflow: 'hidden' },
        fill: { height: '100%', backgroundColor: theme.colors.accentPrimary },
    });

export function KbHitCard({ hit, rank, best }: { hit: KbSearchHit; rank: number; best: number }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const strength = relativeScore(hit.score ?? 0, best);

    return (
        <View style={styles.card}>
            <View style={styles.row}>
                <Text variant="label" tone="accent">
                    #{rank}
                </Text>
                <Text variant="caption" weight="medium" numberOfLines={1} style={styles.grow}>
                    {hit.title || 'Untitled passage'}
                </Text>
            </View>

            <View
                accessibilityLabel={`Match strength ${Math.round(strength * 100)} percent of the best result`}
                style={styles.track}
            >
                <View style={[styles.fill, { width: `${Math.max(4, Math.round(strength * 100))}%` }]} />
            </View>

            <Text variant="caption" tone="secondary" selectable>
                {condense(hit.content, 400)}
            </Text>

            {hit.source_uri ? (
                <View style={styles.source}>
                    <Icon name="Link" size={11} color={theme.colors.textMuted} />
                    <Text variant="label" tone="tertiary" numberOfLines={1} style={styles.grow}>
                        {hit.source_uri}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}
