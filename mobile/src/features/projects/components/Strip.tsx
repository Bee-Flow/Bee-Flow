/**
 * A one-line notice ABOVE a list, about the list as a whole — the web's
 * `Strip` (projects/solutionNotices.jsx): a quiet secondary surface, a glyph
 * in the tone's ink, the sentence in primary ink, and an optional smaller
 * line under it (usually which parts could not be read).
 *
 * Not a finding and not a Banner: a finding is a row with its own severity,
 * and a Banner is a problem with the screen. This is the sentence that says
 * how much the list below is worth. `quiet` has no glyph — the web's `Note`,
 * for a section with nothing to list.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, tonePair, type IconName } from '@/shared/ui';

export type StripTone = 'error' | 'warning' | 'muted' | 'quiet';

const GLYPH: Record<Exclude<StripTone, 'quiet'>, IconName> = {
    error: 'TriangleAlert',
    warning: 'TriangleAlert',
    muted: 'Info',
};

export function Strip({
    tone,
    icon,
    children,
    detail,
    testID,
}: {
    tone: StripTone;
    icon?: IconName;
    children: string;
    detail?: string | null;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.strip} testID={testID}>
            {tone === 'quiet' ? null : (
                <Icon name={icon ?? GLYPH[tone]} size={16} color={styles.glyph[tone]} />
            )}
            <View style={styles.body}>
                <Text variant={tone === 'quiet' ? 'caption' : 'body'} tone={tone === 'quiet' ? 'tertiary' : 'primary'}>
                    {children}
                </Text>
                {detail ? (
                    <Text variant="caption" tone="tertiary">
                        {detail}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    strip: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing[2.5],
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    body: { flex: 1, gap: theme.spacing.xxs } satisfies ViewStyle,
    glyph: {
        error: tonePair(theme.colors, 'error').ink,
        warning: tonePair(theme.colors, 'warning').ink,
        muted: theme.colors.textTertiary,
    } as Record<Exclude<StripTone, 'quiet'>, string>,
});
