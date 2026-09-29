/**
 * One block on the Library hub.
 *
 * The hub is a map, not a list: each section shows the three or four most
 * recent items and hands off to a full screen. So each block has to cover the
 * same four states a list screen does — a section that silently shows nothing
 * while its query fails is how a person concludes their documents are gone.
 *
 * "See all" is in the header rather than under the rows because the header is
 * where the eye already is when a section turns out not to hold what was
 * wanted, and a footer link means scrolling past the wrong four items first.
 */

import { Feather } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { Skeleton, describeError } from '../../../ui/Feedback';
import { Text } from '../../../ui/Text';

export function HubSection({
    title,
    icon,
    /** Total across the whole collection, not just the rows shown. */
    count,
    onSeeAll,
    seeAllLabel = 'See all',
    loading = false,
    error,
    onRetry,
    emptyTitle,
    emptyMessage,
    emptyActionLabel,
    onEmptyAction,
    children,
    /** True when `children` renders nothing — the section can't introspect it. */
    isEmpty = false,
}: {
    title: string;
    icon: keyof typeof Feather.glyphMap;
    count?: number;
    onSeeAll?: () => void;
    seeAllLabel?: string;
    loading?: boolean;
    error?: unknown;
    onRetry?: () => void;
    emptyTitle: string;
    emptyMessage: string;
    emptyActionLabel?: string;
    onEmptyAction?: () => void;
    children?: ReactNode;
    isEmpty?: boolean;
}) {
    const theme = useTheme();

    return (
        <View style={{ gap: theme.spacing.sm }}>
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                }}
            >
                <Feather name={icon} size={16} color={theme.colors.textMuted} />
                <Text variant="subheading" accessibilityRole="header" style={{ flex: 1 }}>
                    {title}
                    {typeof count === 'number' && count > 0 ? (
                        <Text variant="subheading" tone="tertiary">
                            {`  ${count}`}
                        </Text>
                    ) : null}
                </Text>
                {onSeeAll ? (
                    <Pressable
                        onPress={onSeeAll}
                        hitSlop={theme.hitSlop}
                        accessibilityRole="button"
                        accessibilityLabel={`${seeAllLabel} ${title.toLowerCase()}`}
                        style={{ minHeight: 32, justifyContent: 'center' }}
                    >
                        <Text variant="caption" tone="accent" weight="medium">
                            {seeAllLabel}
                        </Text>
                    </Pressable>
                ) : null}
            </View>

            <View
                style={{
                    marginHorizontal: theme.spacing.lg,
                    borderRadius: theme.radii.lg,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: theme.colors.borderSubtle,
                    backgroundColor: theme.colors.bgCard,
                    overflow: 'hidden',
                }}
            >
                {loading ? (
                    <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
                        <Skeleton width="70%" height={14} />
                        <Skeleton width="45%" height={11} />
                        <Skeleton width="60%" height={14} />
                    </View>
                ) : error ? (
                    <SectionProblem error={error} onRetry={onRetry} />
                ) : isEmpty ? (
                    <SectionEmpty
                        title={emptyTitle}
                        message={emptyMessage}
                        actionLabel={emptyActionLabel}
                        onAction={onEmptyAction}
                    />
                ) : (
                    children
                )}
            </View>
        </View>
    );
}

/**
 * A section-sized failure. Compact on purpose: five stacked full ErrorStates
 * on one screen is a wall of red that says nothing about which part still
 * works, and on this hub the other four sections usually do.
 */
function SectionProblem({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    const theme = useTheme();
    const { title, message, retryable } = describeError(error);
    return (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Feather name="alert-circle" size={16} color={theme.colors.error} />
                <Text variant="caption" weight="medium">
                    {title}
                </Text>
            </View>
            <Text variant="caption" tone="tertiary">
                {message}
            </Text>
            {retryable && onRetry ? (
                <Pressable
                    onPress={onRetry}
                    accessibilityRole="button"
                    accessibilityLabel="Try again"
                    style={{ minHeight: 40, justifyContent: 'center' }}
                >
                    <Text variant="caption" tone="accent" weight="medium">
                        Try again
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

function SectionEmpty({
    title,
    message,
    actionLabel,
    onAction,
}: {
    title: string;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
}) {
    const theme = useTheme();
    return (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.xs }}>
            <Text variant="caption" weight="medium">
                {title}
            </Text>
            <Text variant="caption" tone="tertiary">
                {message}
            </Text>
            {actionLabel && onAction ? (
                // A real button. This was the second copy of the mistake
                // EmptyState had — a call to action drawn as a caption-sized
                // text link, in a section that owns the top third of the
                // Library tab. The contrast pass fixed EmptyState and never
                // found this one, which is the argument for there being one
                // empty state rather than two.
                <View style={{ alignItems: 'flex-start', marginTop: theme.spacing.xs }}>
                    <Button label={actionLabel} onPress={onAction} variant="secondary" />
                </View>
            ) : null}
        </View>
    );
}
