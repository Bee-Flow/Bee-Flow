/**
 * A tall sheet listing switches — a member's groups, a group's candidates —
 * virtualised, because an organisation's groups and people have no upper
 * bound. With `searchPlaceholder` it filters by label, like the web's
 * "Search groups…" and "Search users to add…" popovers.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, InsetDivider, SearchField, Sheet, ToggleRow } from '@/shared/ui';

export interface ToggleItem {
    id: string;
    label: string;
    description?: string;
    on: boolean;
    disabled?: boolean;
    toggle: (next: boolean) => void;
}

const renderItem: ListRenderItem<ToggleItem> = ({ item }) => (
    <ToggleRow
        testID={`toggle-${item.id}`}
        label={item.label}
        description={item.description}
        value={item.on}
        disabled={item.disabled}
        onValueChange={item.toggle}
    />
);
const keyOf = (item: ToggleItem) => item.id;

/** What the empty list offers instead (the groups sheet: go and make one). */
export interface EmptyAction {
    label: string;
    onPress: () => void;
}

export function ToggleListSheet({
    visible,
    onClose,
    title,
    items,
    emptyTitle,
    searchPlaceholder,
    noMatchTitle,
    emptyAction,
}: {
    visible: boolean;
    onClose: () => void;
    title: string;
    items: ToggleItem[];
    emptyTitle: string;
    searchPlaceholder?: string;
    noMatchTitle?: string;
    emptyAction?: EmptyAction;
}) {
    const styles = useThemedStyles(makeStyles);
    const [search, setSearch] = useState('');
    const needle = search.trim().toLowerCase();
    const rows = needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items;
    const onEmptyAction = emptyAction
        ? () => {
              onClose();
              emptyAction.onPress();
          }
        : undefined;
    return (
        <Sheet visible={visible} onClose={onClose} title={title} scroll={false} tall>
            <View style={styles.body}>
                {searchPlaceholder && items.length > 0 ? (
                    <SearchField value={search} onChangeText={setSearch} placeholder={searchPlaceholder} />
                ) : null}
                {rows.length === 0 ? (
                    <EmptyState
                        icon="Users"
                        title={needle && noMatchTitle ? noMatchTitle : emptyTitle}
                        actionLabel={needle ? undefined : emptyAction?.label}
                        onAction={needle ? undefined : onEmptyAction}
                    />
                ) : (
                    <FlatList
                        data={rows}
                        renderItem={renderItem}
                        keyExtractor={keyOf}
                        ItemSeparatorComponent={InsetDivider}
                        keyboardShouldPersistTaps="handled"
                    />
                )}
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { flex: 1, gap: theme.spacing.sm },
    });
