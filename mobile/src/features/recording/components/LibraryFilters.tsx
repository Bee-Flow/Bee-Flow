/**
 * The library's controls, as the web rail draws them (agent-hub
 * LibraryFilters.jsx): search, a sort button with its menu, then one line of
 * chips — All · Mine · Shared, and the counted tags, folded behind "+N tags".
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Chip, Icon, IconButton, SearchField } from '@/shared/ui';

import {
    LIBRARY_SORTS,
    visibleTags,
    type LibraryFilter,
    type LibraryOwner,
    type LibrarySort,
    type TagCount,
} from '../model/library';

const styles = StyleSheet.create({
    stack: { gap: 8 },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    search: { flex: 1 },
    chips: { flexDirection: 'row', gap: 6, paddingVertical: 2 },
});

function sortLabel(sort: LibrarySort, t: TranslateFn): string {
    if (sort === 'oldest') return t('meetings.sort_oldest', 'Oldest first');
    if (sort === 'longest') return t('meetings.sort_longest', 'Longest first');
    if (sort === 'title') return t('meetings.sort_title', 'Title (A → Z)');
    return t('meetings.sort_newest', 'Newest first');
}

function ownerChips(t: TranslateFn, signedIn: boolean): { value: LibraryOwner; label: string }[] {
    const all = { value: 'all' as const, label: t('meetings.filter_all', 'All') };
    if (!signedIn) return [all];
    return [
        all,
        { value: 'mine', label: t('meetings.filter_mine', 'Mine') },
        { value: 'shared', label: t('meetings.filter_shared', 'Shared') },
    ];
}

export interface LibraryFiltersProps {
    filter: LibraryFilter;
    onChange: (patch: Partial<LibraryFilter>) => void;
    tags: readonly TagCount[];
    signedIn: boolean;
}

export function LibraryFilters({ filter, onChange, tags, signedIn }: LibraryFiltersProps) {
    const t = useTranslation();
    const theme = useTheme();
    const [sorting, setSorting] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const { shown, hidden } = visibleTags(tags, filter.tag, expanded);
    const sortItems = LIBRARY_SORTS.map((sort) => ({
        id: sort,
        label: sortLabel(sort, t),
        selected: sort === filter.sort,
        onPress: () => onChange({ sort }),
    }));

    return (
        <View style={styles.stack}>
            <View style={styles.searchRow}>
                <SearchField
                    style={styles.search}
                    value={filter.query}
                    onChangeText={(query) => onChange({ query })}
                    placeholder={t('meetings.search_placeholder', 'Search title, tag or text…')}
                />
                <IconButton
                    icon={<Icon name="ListOrdered" size={18} color={theme.colors.textSecondary} />}
                    accessibilityLabel={t('meetings.sort_label', 'Sort')}
                    accessibilityHint={sortLabel(filter.sort, t)}
                    onPress={() => setSorting(true)}
                />
            </View>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                accessibilityLabel={t('meetings.filters_label', 'Filters')}
                contentContainerStyle={styles.chips}
            >
                {ownerChips(t, signedIn).map((option) => (
                    <Chip
                        key={option.value}
                        label={option.label}
                        selected={filter.owner === option.value}
                        onPress={() => onChange({ owner: option.value })}
                    />
                ))}
                {shown.map((row) => (
                    <Chip
                        key={`tag:${row.tag}`}
                        label={row.tag}
                        count={row.count}
                        selected={filter.tag === row.tag}
                        onPress={() => onChange({ tag: filter.tag === row.tag ? null : row.tag })}
                    />
                ))}
                {hidden > 0 ? (
                    <Chip
                        label={t('meetings.more_tags', '+{count} tags', { count: hidden })}
                        tone="muted"
                        onPress={() => setExpanded(true)}
                    />
                ) : null}
                {expanded ? (
                    <Chip label={t('meetings.fewer_tags', 'Fewer tags')} tone="muted" onPress={() => setExpanded(false)} />
                ) : null}
            </ScrollView>
            <ActionMenu
                visible={sorting}
                onClose={() => setSorting(false)}
                title={t('meetings.sort_label', 'Sort')}
                items={sortItems}
            />
        </View>
    );
}
