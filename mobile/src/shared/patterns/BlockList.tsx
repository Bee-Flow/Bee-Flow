/**
 * A scrolling page of blocks — banners, sections, cards — virtualised, so a
 * section that can grow without bound (a project's automations, the schedules
 * on the Cowork hub) no longer renders every row up front in a ScrollView.
 *
 * Each block is one FlatList cell with the spacing the page's `gap` used to
 * give it. `cardRows` turns an unbounded list into one cell per row, each a
 * slice of the same card (top edge on the first, bottom edge on the last,
 * inset hairlines between), so the card reads as one surface as before.
 */

import React, { type ReactElement } from 'react';
import {
    FlatList,
    RefreshControl,
    StyleSheet,
    View,
    type ListRenderItem,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Divider } from '@/shared/ui';

/** Space above a block: a new section, the next part of one, or none (same card). */
export type BlockGap = 'section' | 'inner' | 'none';

export interface Block {
    key: string;
    gap: BlockGap;
    render: () => ReactElement | null;
}

export interface BlockListProps {
    blocks: readonly Block[];
    refreshing: boolean;
    onRefresh: () => void;
    contentContainerStyle?: StyleProp<ViewStyle>;
    testID?: string;
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        section: { marginTop: theme.spacing.xl },
        inner: { marginTop: theme.spacing.md },
        none: {},
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl },
        slice: {
            backgroundColor: theme.colors.bgCard,
            borderColor: theme.colors.cardBorder,
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderRightWidth: StyleSheet.hairlineWidth,
            overflow: 'hidden',
        },
        top: {
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopLeftRadius: theme.radii.lg,
            borderTopRightRadius: theme.radii.lg,
        },
        bottom: {
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomLeftRadius: theme.radii.lg,
            borderBottomRightRadius: theme.radii.lg,
        },
    });

/** One row of a card, painted as the matching slice of the card's surface. */
function CardSlice({ first, last, children }: { first: boolean; last: boolean; children: ReactElement }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={[styles.slice, first ? styles.top : null, last ? styles.bottom : null]}>
            {first ? null : <Divider inset={theme.spacing.lg} />}
            {children}
        </View>
    );
}

export interface CardRowsOptions<T> {
    /** Prefix for the row blocks' keys. */
    key: string;
    rows: readonly T[];
    rowKey: (row: T) => string;
    render: (row: T) => ReactElement;
    /** Space above the first row — the gap between a section's title and its card. */
    gap?: BlockGap;
}

/** One block per row of a card; the rows after the first continue the same card. */
export function cardRows<T>({ key, rows, rowKey, render, gap = 'inner' }: CardRowsOptions<T>): Block[] {
    return rows.map((row, index) => ({
        key: `${key}:${rowKey(row)}`,
        gap: index === 0 ? gap : 'none',
        render: () => (
            <CardSlice first={index === 0} last={index === rows.length - 1}>
                {render(row)}
            </CardSlice>
        ),
    }));
}

function BlockCell({ block, first }: { block: Block; first: boolean }) {
    const styles = useThemedStyles(makeStyles);
    return <View style={first ? undefined : styles[block.gap]}>{block.render()}</View>;
}

const renderBlock: ListRenderItem<Block> = ({ item, index }) => <BlockCell block={item} first={index === 0} />;
const blockKey = (block: Block) => block.key;

export function BlockList({ blocks, refreshing, onRefresh, contentContainerStyle, testID }: BlockListProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <FlatList
            testID={testID}
            data={blocks}
            keyExtractor={blockKey}
            renderItem={renderBlock}
            contentContainerStyle={contentContainerStyle ?? styles.content}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
        />
    );
}
