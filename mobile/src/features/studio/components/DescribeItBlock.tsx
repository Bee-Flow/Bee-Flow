/**
 * One building block on the Describe-it card — the web's BlockRow
 * (studioAi/DescribeItPanel.jsx): the kind's glyph in its colour on an 8%
 * tint of it, the kind's New-menu word, the proposed name, and a note (a
 * companion says it is shown for context only).
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { perTheme, useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KIND_ICON, KIND_KEYS, kindColor, Text, tint, type KindKey } from '@/shared/ui';

import { kindWord } from '../model/describeIt';

export interface DescribeItBlockProps {
    kind: KindKey;
    name: string;
    note?: string;
}

export function DescribeItBlock({ kind, name, note }: DescribeItBlockProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View testID={`studio-ai-block-${kind}`} style={[styles.row, styles.fill[kind]]}>
            <Icon name={KIND_ICON[kind]} size={14} color={kindColor(theme, kind)} style={styles.glyph} accessibilityElementsHidden />
            <View style={styles.words}>
                <Text variant="caption" weight="medium">
                    {kindWord(kind, t)}
                    {name ? (
                        <Text variant="caption" tone="secondary">
                            {` · ${name}`}
                        </Text>
                    ) : null}
                </Text>
                {note ? (
                    <Text variant="label" tone="tertiary">
                        {note}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

const makeStyles = perTheme((theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing[2],
        paddingHorizontal: theme.spacing[2],
        paddingVertical: theme.spacing[1.5],
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    // The web's `mt-[2px]`: level with the first line of words.
    glyph: { marginTop: 2 } satisfies ViewStyle,
    words: { flex: 1, gap: 2 } satisfies ViewStyle,
    /** kindTint(kind, 8) per kind. */
    fill: Object.fromEntries(KIND_KEYS.map((k) => [k, { backgroundColor: tint(kindColor(theme, k), 8) }])) as Record<KindKey, ViewStyle>,
}));
