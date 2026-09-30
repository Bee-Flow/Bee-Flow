/**
 * Knowledge bases — the web's KnowledgeOverview on a phone: every base the
 * caller may reach, filtered by category (or by the ones they starred), with
 * the Bee Flow system bases one row away.
 *
 * The list endpoint already filters by what the caller may reach, so
 * everything returned is openable. "Query everything" is in the header,
 * because the commonest question is "do we have anything about X at all",
 * and the search route answers exactly that when it is given no ids.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { ActionMenu, FilterPills, Icon, IconButton, ListRow, Screen, ScreenHeader, type FilterPillOption } from '@/shared/ui';

import { AddFab } from '../components/AddFab';
import { KbDeleteSheets } from '../components/KbDeleteSheets';
import { KbQuerySheet } from '../components/KbQuerySheet';
import { KnowledgeBaseRow } from '../components/KnowledgeBaseRow';
import { NewKnowledgeBaseSheet } from '../components/NewKnowledgeBaseSheet';
import { SystemKnowledgeSheet } from '../components/SystemKnowledgeSheet';
import { useKbCategories, useKbFavorites, useToggleKbFavorite } from '../hooks/manage';
import { useKnowledgeBases } from '../hooks/queries';
import { matchesFilter, type ListFilter } from '../model/settings';
import type { KbCategory, KnowledgeBase } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        list: { paddingBottom: 96 },
        head: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, gap: theme.spacing.sm },
    });

const matches = (kb: KnowledgeBase, needle: string) =>
    kb.name.toLowerCase().includes(needle) || (kb.description ?? '').toLowerCase().includes(needle);

function filterOptions(t: TranslateFn, categories: readonly KbCategory[]): FilterPillOption<ListFilter>[] {
    return [
        { value: 'all', label: t('knowledge.filter_all', 'All') },
        { value: 'favorites', label: t('mobile.knowledge.favorites', 'Favourites') },
        ...categories.map((c) => ({ value: `category:${c.id}` as ListFilter, label: c.name })),
        { value: 'uncategorised', label: t('knowledge.filter_uncategorised', 'Uncategorised') },
    ];
}

/** `startCreating` opens the new-base sheet at once: the Studio New menu's `/knowledge?new=1`. */
export function KnowledgeListScreen({ startCreating }: { startCreating?: boolean }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    const [creating, setCreating] = useState(startCreating === true);
    const [queryOpen, setQueryOpen] = useState(false);
    const [systemOpen, setSystemOpen] = useState(false);
    const [filter, setFilter] = useState<ListFilter>('all');
    const [menuFor, setMenuFor] = useState<KnowledgeBase | null>(null);
    const [pendingDelete, setPendingDelete] = useState<KnowledgeBase | null>(null);
    const query = useKnowledgeBases();
    const favorites = useKbFavorites().data ?? new Set<string>();
    const categories = useKbCategories().data ?? [];
    const toggleFavorite = useToggleKbFavorite();
    const starred = menuFor ? favorites.has(menuFor.id) : false;

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title={t('knowledge.title', 'Knowledge bases')}
                actions={
                    <IconButton icon={<Icon name="Search" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel={t('mobile.knowledge.query_all', 'Query every knowledge base')} onPress={() => setQueryOpen(true)} />
                }
            />
            <QueryList
                query={query}
                keyExtractor={(kb) => kb.id}
                separator="none"
                search={{ placeholder: t('knowledge.search', 'Search a knowledge base…'), match: matches }}
                filter={(kb) => matchesFilter(kb, filter, favorites)}
                contentContainerStyle={styles.list}
                ListHeaderComponent={
                    <View style={styles.head}>
                        <FilterPills scroll value={filter} onChange={setFilter} accessibilityLabel={t('knowledge.filter_label', 'Filter by category')} options={filterOptions(t, categories)} />
                        <ListRow title={t('mobile.knowledge.system_title', 'System knowledge bases')} subtitle={t('mobile.knowledge.system_hint', 'Read-only collections maintained by Bee Flow')}
                            leading={<Icon name="Shield" size={18} color={theme.colors.textMuted} />} chevron onPress={() => setSystemOpen(true)} />
                    </View>
                }
                renderItem={({ item }) => (
                    <KnowledgeBaseRow kb={item} favorite={favorites.has(item.id)} onPress={() => router.push(`/knowledge/${item.id}`)} onLongPress={() => setMenuFor(item)} />
                )}
                empty={{
                    icon: 'Database',
                    title: t('knowledge.empty_title', 'No knowledge bases yet'),
                    message: t('knowledge.empty_body', 'A knowledge base is the material your AI may quote from: a folder, a table, a page, meeting notes. Add sources once and they keep themselves up to date.'),
                    actionLabel: t('knowledge.new', 'New knowledge base'),
                    onAction: () => setCreating(true),
                }}
                noMatch={{ title: t('knowledge.search_empty', 'No knowledge base matches that.'), message: t('mobile.knowledge.no_match_hint', 'Try a different word.') }}
            />
            <AddFab label={t('knowledge.new', 'New knowledge base')} onPress={() => setCreating(true)} />

            <NewKnowledgeBaseSheet visible={creating} onClose={() => setCreating(false)}
                onCreated={(kb) => {
                    setCreating(false);
                    if (kb?.id) router.push(`/knowledge/${kb.id}`);
                }} />
            <KbQuerySheet visible={queryOpen} onClose={() => setQueryOpen(false)} kbName={t('mobile.knowledge.everything', 'Everything you can reach')} />
            <ActionMenu
                visible={menuFor !== null}
                onClose={() => setMenuFor(null)}
                title={menuFor?.name}
                items={[
                    { id: 'fav', icon: 'Star', label: starred ? t('mobile.knowledge.unfavorite', 'Remove from favourites') : t('mobile.knowledge.favorite', 'Add to favourites'),
                        onPress: () => menuFor && toggleFavorite.mutate({ id: menuFor.id, favorite: !starred }) },
                    { id: 'delete', icon: 'Trash2', destructive: true, label: t('knowledge.settings.delete_open', 'Delete this knowledge base'), onPress: () => setPendingDelete(menuFor) },
                ]}
            />
            <KbDeleteSheets kb={pendingDelete} onDone={() => setPendingDelete(null)} />
            <SystemKnowledgeSheet visible={systemOpen} onClose={() => setSystemOpen(false)} />
        </Screen>
    );
}
