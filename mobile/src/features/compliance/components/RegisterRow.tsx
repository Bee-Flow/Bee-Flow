/**
 * A register row drawn from the type's `rowView` (web: the register tables'
 * phone card): the title, a one-line subtitle, a second meta line, then the
 * status badge and/or the deadline clock. A 3px stripe on the left carries
 * the row's tone; a dimmed row (closed, archived) reads in tertiary ink.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, Text, tonePair, type Tone } from '@/shared/ui';

import { DeadlineClock } from './DeadlineClock';
import type { RecordTone, RowView } from '../model/types';

export interface RegisterRowProps {
    view: RowView & { title: string };
    onPress: () => void;
    testID?: string;
}

export function RegisterRow({ view, onPress, testID }: RegisterRowProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const ink = view.dimmed ? 'tertiary' : 'primary';
    return (
        <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={view.title} accessibilityHint={view.subtitle ?? undefined}>
            {({ pressed }) => (
                <View style={[styles.row, pressed ? styles.pressed : null]}>
                    <View testID={testID ? `${testID}-accent` : undefined} style={[styles.stripe, view.accent ? styles[view.accent] : null]} />
                    <View style={styles.text}>
                        <Text variant="subheading" tone={ink} numberOfLines={2}>
                            {view.title}
                        </Text>
                        {view.subtitle ? (
                            <Text variant="caption" tone="tertiary" numberOfLines={1}>
                                {view.subtitle}
                            </Text>
                        ) : null}
                        {view.meta ? (
                            <Text variant="label" tone="tertiary" numberOfLines={1}>
                                {view.meta}
                            </Text>
                        ) : null}
                    </View>
                    <View style={styles.trailing}>
                        {view.badge ? <Badge label={view.badge.label} tone={view.badge.tone} /> : null}
                        {view.clock ? <DeadlineClock clock={view.clock} variant="inline" testID={testID ? `${testID}-clock` : undefined} /> : null}
                    </View>
                    <Icon name="ChevronRight" size={18} color={theme.colors.textMuted} />
                </View>
            )}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => {
    const stripe = (tone: RecordTone) => ({ backgroundColor: tonePair(theme.colors, tone as Tone).raw });
    return StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: 52,
            paddingRight: theme.spacing.lg,
            paddingVertical: theme.spacing.sm,
            gap: theme.spacing.md,
        },
        pressed: { backgroundColor: theme.colors.itemHoverBg },
        stripe: { alignSelf: 'stretch', width: 3, marginRight: theme.spacing.lg - theme.spacing.md - 3, borderRadius: 2 },
        text: { flex: 1, gap: 2 },
        trailing: { alignItems: 'flex-end', gap: theme.spacing.xs, flexShrink: 0 },
        success: stripe('success'),
        warning: stripe('warning'),
        error: stripe('error'),
        info: stripe('info'),
        neutral: stripe('neutral'),
    });
};
