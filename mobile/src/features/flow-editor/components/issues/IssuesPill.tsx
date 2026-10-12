/**
 * The findings chip that floats over the flow — the web's
 * FloatingValidationPill: a dot and a count in the severity's colour (or the
 * one finding's own words), nothing at all when the automation is healthy.
 * Tapping it opens the list.
 */

import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, tint } from '@/shared/ui';

import type { PillSummary } from './issuesModel';

const makeStyles = (theme: Theme) => ({
    wrap: { position: 'absolute', left: theme.spacing[4], right: theme.spacing[4], bottom: theme.spacing[4], alignItems: 'center' } satisfies ViewStyle,
    pill: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], maxWidth: '100%', minHeight: 40,
        paddingHorizontal: theme.spacing[3.5], borderRadius: theme.radii.pill, borderWidth: 1,
        backgroundColor: theme.colors.bgCard, boxShadow: theme.shadows.popover,
    } satisfies ViewStyle,
    error: { borderColor: tint(theme.colors.error, 60) } satisfies ViewStyle,
    warning: { borderColor: tint(theme.colors.warning, 60) } satisfies ViewStyle,
    dot: { width: 8, height: 8, borderRadius: 4 } satisfies ViewStyle,
    dotError: { backgroundColor: theme.colors.error } satisfies ViewStyle,
    dotWarning: { backgroundColor: theme.colors.warning } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    text: { flexShrink: 1 },
});

export function IssuesPill({ summary, onPress }: { summary: PillSummary | null; onPress: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    if (!summary) return null;
    const error = summary.tone === 'error';
    return (
        <View style={styles.wrap} pointerEvents="box-none">
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={summary.text}
                accessibilityHint={t('mobile.flow.issues.open_hint', 'Shows every finding and where to fix it')}
                style={[styles.pill, error ? styles.error : styles.warning]}
                testID="issues-pill"
            >
                <View style={[styles.dot, error ? styles.dotError : styles.dotWarning]} />
                <Text variant="caption" weight="semibold" tone={error ? 'error' : 'warning'} numberOfLines={1} style={styles.text}>
                    {summary.text}
                </Text>
                <Icon name="ChevronUp" size={14} color={styles.glyph.color} />
            </Pressable>
        </View>
    );
}
