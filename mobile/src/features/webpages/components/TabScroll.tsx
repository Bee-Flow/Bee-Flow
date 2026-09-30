/**
 * The body of a tab whose content has an upper bound (Share, Settings): a
 * pull-to-refresh scroll view with the page gutter. Tabs with lists that grow
 * (Knowledge, History, the code viewer) bring their own FlatList instead.
 *
 * `onRefresh` is what a pull runs; return its promise. The spinner shows for
 * that pull only (useUserRefresh), never for a background refetch.
 */

import React, { type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl },
    });

export function TabScroll({
    onRefresh,
    children,
    testID,
}: {
    onRefresh: () => unknown;
    children: ReactNode;
    testID?: string;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { refreshing, onRefresh: pull } = useUserRefresh(onRefresh);
    return (
        <ScrollView
            testID={testID}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={pull}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
        >
            {children}
        </ScrollView>
    );
}
