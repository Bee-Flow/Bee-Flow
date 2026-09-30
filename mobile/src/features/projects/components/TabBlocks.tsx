/**
 * The body of one Solution tab: a virtualised BlockList with the page gutter
 * and room above the first block, under the object header's tab strip.
 *
 * `onRefresh` is what a pull runs; return its promise. The spinner shows for
 * that pull only (useUserRefresh), never for a background refetch.
 */

import React from 'react';
import { StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BlockList, useUserRefresh, type Block } from '@/shared/patterns';

export function TabBlocks({
    blocks,
    onRefresh,
    testID,
}: {
    blocks: readonly Block[];
    onRefresh: () => unknown;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const refresh = useUserRefresh(onRefresh);
    return (
        <BlockList
            blocks={blocks}
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            contentContainerStyle={styles.content}
            testID={testID}
        />
    );
}

/** A block that is one element, spaced as a new section. */
export function block(key: string, render: Block['render'], gap: Block['gap'] = 'section'): Block {
    return { key, gap, render };
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.xxxl },
    });
