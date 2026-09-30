/**
 * One block on the Library hub.
 *
 * The hub is a map, not a list: each section shows the few most recent items
 * and hands off to a full screen. So each block covers the same four states a
 * list screen does — a section that silently shows nothing while its query
 * fails is how a person concludes their documents are gone.
 *
 * "See all" is in the header rather than under the rows because the header is
 * where the eye already is when a section turns out not to hold what was
 * wanted.
 */

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Skeleton, Text, type IconName } from '@/shared/ui';

import { HubSectionEmpty } from './HubSectionEmpty';
import { HubSectionProblem } from './HubSectionProblem';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        section: { gap: theme.spacing.sm },
        header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg },
        title: { flex: 1 },
        seeAll: { minHeight: 32, justifyContent: 'center' },
        card: {
            marginHorizontal: theme.spacing.lg,
            borderRadius: theme.radii.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgCard,
            overflow: 'hidden',
        },
        skeleton: { padding: theme.spacing.lg, gap: theme.spacing.md },
    });

export interface HubSectionProps {
    title: string;
    icon: IconName;
    /** Total across the whole collection, not just the rows shown. */
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
    /** True when `children` renders nothing — the section can't introspect it. */
    isEmpty?: boolean;
}

function HubSectionBody(props: HubSectionProps) {
    const styles = useThemedStyles(makeStyles);
    if (props.loading) {
        return (
            <View style={styles.skeleton}>
                <Skeleton width="70%" height={14} />
                <Skeleton width="45%" height={11} />
                <Skeleton width="60%" height={14} />
            </View>
        );
    }
    if (props.error) return <HubSectionProblem error={props.error} onRetry={props.onRetry} />;
    if (props.isEmpty) {
        return (
            <HubSectionEmpty
                title={props.emptyTitle}
                message={props.emptyMessage}
                actionLabel={props.emptyActionLabel}
                onAction={props.onEmptyAction}
            />
        );
    }
    return <>{props.children}</>;
}

export function HubSection(props: HubSectionProps) {
    const { title, icon, count, onSeeAll, seeAllLabel = 'See all' } = props;
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    return (
        <View style={styles.section}>
            <View style={styles.header}>
                <Icon name={icon} size={16} color={theme.colors.textMuted} />
                <Text variant="subheading" accessibilityRole="header" style={styles.title}>
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
                        style={styles.seeAll}
                    >
                        <Text variant="caption" tone="accent" weight="medium">
                            {seeAllLabel}
                        </Text>
                    </Pressable>
                ) : null}
            </View>

            <View style={styles.card}>
                <HubSectionBody {...props} />
            </View>
        </View>
    );
}
