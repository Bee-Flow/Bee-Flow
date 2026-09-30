/** One changelog entry: title, version, date, lead and its first four items. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { absoluteDate } from '@/shared/lib/display';
import { Badge, Text } from '@/shared/ui';

import type { ReleaseNote } from '../model/types';

export function ReleaseNoteItem({ entry }: { entry: ReleaseNote }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.entry}>
            <View style={styles.header}>
                <Text variant="subheading" style={styles.title}>
                    {entry.title}
                </Text>
                {entry.version ? <Badge label={entry.version} /> : null}
            </View>
            <Text variant="label" tone="tertiary">
                {absoluteDate(entry.publishedAt)}
            </Text>
            {entry.lead ? (
                <Text variant="caption" tone="secondary">
                    {entry.lead}
                </Text>
            ) : null}
            {entry.items.slice(0, 4).map((item, index) => (
                <Text key={index} variant="caption" tone="tertiary">
                    {'•'}  {item}
                </Text>
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        entry: { padding: theme.spacing.lg, gap: theme.spacing.xs },
        header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
    });
