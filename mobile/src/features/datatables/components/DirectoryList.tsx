/**
 * People or groups to pick from — virtualised, because an organisation's
 * directory has no upper bound. One row per entry; the caller decides whether
 * a tap picks one or ticks several.
 */

import React, { useCallback } from 'react';
import { FlatList, StyleSheet, type ListRenderItem } from 'react-native';

import { OptionRow, Text } from '@/shared/ui';

import type { DirectoryPerson } from '../model/types';

const styles = StyleSheet.create({ list: { flexGrow: 0, maxHeight: 360 }, empty: { padding: 16 } });

const keyOf = (entry: DirectoryPerson) => entry.id;

export function DirectoryList({
    entries,
    isSelected,
    onToggle,
    emptyText,
}: {
    entries: readonly DirectoryPerson[];
    isSelected: (id: string) => boolean;
    onToggle: (id: string) => void;
    emptyText: string;
}) {
    const renderItem = useCallback<ListRenderItem<DirectoryPerson>>(
        ({ item }) => <OptionRow label={item.name || item.id} selected={isSelected(item.id)} onPress={() => onToggle(item.id)} />,
        [isSelected, onToggle],
    );
    return (
        <FlatList
            data={entries}
            keyExtractor={keyOf}
            renderItem={renderItem}
            style={styles.list}
            ListEmptyComponent={
                <Text variant="caption" tone="tertiary" style={styles.empty}>
                    {emptyText}
                </Text>
            }
        />
    );
}
