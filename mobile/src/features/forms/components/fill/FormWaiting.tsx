/**
 * The screen a person sits on while the routine works — the web's
 * FormWaitingView. The stretch between two pages is whatever the author put
 * there (a web search, a model call, a document being written), regularly a
 * minute or more, and a bare spinner reads as "this broke". So it says WHERE
 * the routine is: the step it is on as the headline, the flowlets above it
 * as context, and the running flowlet's own description when it has one.
 * Indeterminate on purpose — the routine cannot say how far along it is.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Spinner, Text } from '@/shared/ui';

export function FormWaiting({ progress, note }: { progress: readonly string[]; note: string | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const trail = progress.filter(Boolean);
    const current = trail.length ? (trail[trail.length - 1] as string) : null;
    const context = trail.slice(0, -1).join(' › ');
    const working = t('mobile.forms.fill.working', 'Working on it');
    return (
        <View style={styles.card} accessibilityRole="progressbar" accessibilityLiveRegion="polite" testID="fill-waiting">
            <Spinner size="large" />
            <View style={styles.text}>
                {context ? (
                    <Text variant="label" tone="accent" numberOfLines={1}>
                        {context}
                    </Text>
                ) : null}
                <Text variant="subheading">{current || `${working}…`}</Text>
                {note ? (
                    <Text variant="caption" tone="secondary">
                        {note}
                    </Text>
                ) : null}
                <Text variant="caption" tone={note ? 'tertiary' : 'secondary'}>
                    {current
                        ? t('mobile.forms.fill.working_long', '{working} — this can take a moment.', { working })
                        : t('mobile.forms.fill.take_a_moment', 'This can take a moment.')}
                </Text>
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.lg,
        padding: theme.spacing.xl,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    text: { flex: 1, minWidth: 0, gap: theme.spacing.xs } satisfies ViewStyle,
});
