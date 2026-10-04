/**
 * The Steps tab: the automation as a vertical outline (rows.ts), virtualised.
 * The rows are rebuilt from the definition on every edit — a pure walk over a
 * graph of tens of steps — and each row reads what it draws from the
 * OutlineContext, so the list's renderItem stays outside the render function.
 */

import React, { useMemo, useRef, type ReactElement } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { buildOutlineRows, type OutlineRow } from '@/features/flow-editor/model/outline';

import { OutlineContext, type OutlineHandlers } from './OutlineContext';
import { OutlineRowView } from './OutlineRows';
import { makeOutlineStyles } from './outlineStyles';

const renderRow: ListRenderItem<OutlineRow> = ({ item }) => <OutlineRowView row={item} />;
const keyOf = (row: OutlineRow) => row.key;

/** Where a node's card sits in the rows, for a jump. */
export function rowIndexOf(rows: readonly OutlineRow[], nodeId: string): number {
    return rows.findIndex((r) => (r.kind === 'step' && r.address === nodeId) || (r.kind === 'trigger' && r.nodeId === nodeId));
}

export interface StepOutlineProps extends Omit<OutlineHandlers, 'onJump'> {
    /** Folded groups (rows.ts groupKey). */
    collapsed: ReadonlySet<string>;
    /** Above the first row: banners, the save status. */
    header?: ReactElement | null;
}

export function StepOutline({ collapsed, header, definition, card, locked, onOpen, onMenu, onAdd, onToggleGroup }: StepOutlineProps) {
    const styles = useThemedStyles(makeOutlineStyles);
    const list = useRef<FlatList<OutlineRow>>(null);
    const rows = useMemo(() => buildOutlineRows(definition, { collapsed }), [definition, collapsed]);
    // Built from the fields, not a `...rest` copy: a rest object is new on
    // every render, and every row reads this context.
    const value = useMemo<OutlineHandlers>(
        () => ({
            definition,
            card,
            locked,
            onOpen,
            onMenu,
            onAdd,
            onToggleGroup,
            onJump: (nodeId: string) => {
                const index = rowIndexOf(rows, nodeId);
                if (index >= 0) list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true });
            },
        }),
        [definition, card, locked, onOpen, onMenu, onAdd, onToggleGroup, rows],
    );
    return (
        <OutlineContext.Provider value={value}>
            <FlatList
                ref={list}
                data={rows}
                renderItem={renderRow}
                keyExtractor={keyOf}
                extraData={value}
                ListHeaderComponent={header}
                contentContainerStyle={styles.list}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={24}
                // Rows differ in height: land near the row, then settle on it.
                onScrollToIndexFailed={({ index, averageItemLength }) => {
                    list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
                    setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true }), 60);
                }}
                testID="step-outline"
            />
        </OutlineContext.Provider>
    );
}
