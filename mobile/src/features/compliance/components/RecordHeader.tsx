/**
 * A register's status line under its intro (web: ComplianceHeader's status
 * row, registerSpecs.tsx): a pill ('2 past the deadline') and caption lines
 * ('Art. 33 · 72 hours to the authority'), from the type's `header` over the
 * list and the hub's counts.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { useCounts } from '../hooks/hub';
import type { Formatter, RecordSet, RecordType } from '../model/types';

export function RecordHeader({ type, set, fmt }: { type: RecordType; set: RecordSet; fmt: Formatter }) {
    const styles = useThemedStyles(makeStyles);
    const counts = useCounts(Boolean(type.header));
    const view = type.header ? type.header(set, fmt, counts.data ?? null) : null;
    if (!view || (!view.pill && !view.lines?.length)) return null;
    return (
        <View style={styles.wrap} testID={`header-${type.id}`}>
            {view.pill ? <Badge testID={`header-${type.id}-pill`} label={view.pill.text} tone={view.pill.tone} /> : null}
            {(view.lines ?? []).map((line) => (
                <Text key={line} variant="caption" tone="secondary">
                    {line}
                </Text>
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => StyleSheet.create({ wrap: { gap: theme.spacing.xs, alignItems: 'flex-start' } });
