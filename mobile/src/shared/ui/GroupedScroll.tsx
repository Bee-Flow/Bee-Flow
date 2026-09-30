/**
 * The body of a grouped, settings-style screen: a padded scroll of Groups,
 * optionally pull-to-refresh.
 *
 * Every settings, organisation, usage, admin and support screen wrote the same
 * ScrollView with the same three paddings and the same accent-tinted
 * RefreshControl. The content is a handful of Groups, bounded by the screen's
 * design — a list that can grow belongs in a FlatList, not here.
 */

import React, { type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

export interface GroupedScrollProps {
    children: ReactNode;
    /** Pull-to-refresh. Omit for a screen with nothing to refetch. */
    refresh?: { refreshing: boolean; onRefresh: () => void };
    /** 'handled' for a screen with a text field, so a tap on a button lands. */
    keyboardShouldPersistTaps?: 'handled';
    testID?: string;
}

export function GroupedScroll({
    children,
    refresh,
    keyboardShouldPersistTaps,
    testID,
}: GroupedScrollProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView
            testID={testID}
            keyboardShouldPersistTaps={keyboardShouldPersistTaps}
            refreshControl={
                refresh ? (
                    <RefreshControl
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                ) : undefined
            }
            contentContainerStyle={styles.content}
        >
            {children}
        </ScrollView>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: {
            padding: theme.spacing.lg,
            gap: theme.spacing.xl,
            paddingBottom: theme.spacing.xxxl,
        },
    });
