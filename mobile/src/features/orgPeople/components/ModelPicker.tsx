/**
 * Pick one model out of every provider's list — the web's <select> of
 * "name (provider)" — searchable and virtualised, since a provider can list
 * hundreds. The first row is the "none" choice the web offers.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, InsetDivider, OptionRow, SearchField } from '@/shared/ui';

import type { ModelOption } from '../model/types';

interface PickerItem {
    id: string;
    label: string;
    description?: string;
    selected: boolean;
    pick: () => void;
}

const renderItem: ListRenderItem<PickerItem> = ({ item }) => (
    <OptionRow
        testID={`model-${item.id || 'none'}`}
        label={item.label}
        description={item.description}
        selected={item.selected}
        onPress={item.pick}
    />
);
const keyOf = (item: PickerItem) => item.id || '__none__';

export function ModelPicker({
    models,
    value,
    noneLabel,
    searchPlaceholder,
    emptyTitle,
    onPick,
}: {
    models: readonly ModelOption[];
    value: string;
    noneLabel: string;
    searchPlaceholder: string;
    emptyTitle: string;
    onPick: (id: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const [search, setSearch] = useState('');
    const needle = search.trim().toLowerCase();
    const matching = needle
        ? models.filter((m) => `${m.name} ${m.id} ${m.providerName}`.toLowerCase().includes(needle))
        : models;
    const items: PickerItem[] = [
        ...(needle ? [] : [{ id: '', label: noneLabel, selected: value === '', pick: () => onPick('') }]),
        ...matching.map((m) => ({
            id: m.id,
            label: m.name,
            description: m.providerName,
            selected: m.id === value,
            pick: () => onPick(m.id),
        })),
    ];
    return (
        <View style={styles.body}>
            <SearchField value={search} onChangeText={setSearch} placeholder={searchPlaceholder} />
            {items.length === 0 ? (
                <EmptyState icon="Cpu" title={emptyTitle} />
            ) : (
                <FlatList
                    data={items}
                    renderItem={renderItem}
                    keyExtractor={keyOf}
                    ItemSeparatorComponent={InsetDivider}
                    keyboardShouldPersistTaps="handled"
                />
            )}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { flex: 1, gap: theme.spacing.sm },
    });
