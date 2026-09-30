/**
 * Notebooks.
 *
 * The list is paged, searched and filtered on the server — routes/notebooks.js
 * whitelists `search`, `sort` and `filter` and returns a card projection with
 * counts and a cached preview rather than document bodies. Doing any of it on
 * the phone would mean downloading every notebook to type three letters.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AddFab } from '@/features/knowledge';
import { QueryList } from '@/shared/patterns';
import { Screen, ScreenHeader, SearchField } from '@/shared/ui';

import type { NotebookFilter } from '../api/endpoints';
import { DeleteNotebookSheet } from '../components/DeleteNotebookSheet';
import { NewNotebookSheet } from '../components/NewNotebookSheet';
import { NotebookFilterChips } from '../components/NotebookFilterChips';
import { NotebookRow } from '../components/NotebookRow';
import { useNotebooks } from '../hooks/queries';
import type { NotebookCard } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        list: { paddingBottom: 96 },
    });

export function NotebooksScreen() {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<NotebookFilter>('all');
    const [creating, setCreating] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<NotebookCard | null>(null);

    const query = useNotebooks(search.trim(), filter);
    const notebooks = {
        data: query.data?.notebooks,
        isLoading: query.isLoading,
        isError: query.isError,
        error: query.error,
        refetch: query.refetch,
    };

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader title={t('notebooks.title', 'Notebooks')} />

            <View style={styles.search}>
                <SearchField value={search} onChangeText={setSearch} placeholder={t('notebooks.search_placeholder', 'Search…')} />
            </View>
            <NotebookFilterChips filter={filter} onChange={setFilter} />

            {/* Searched on the server, so the list only ever shows what came back. */}
            <QueryList
                query={notebooks}
                keyExtractor={(nb) => nb.id}
                separator="none"
                contentContainerStyle={styles.list}
                renderItem={({ item }) => (
                    <NotebookRow
                        notebook={item}
                        onPress={() => router.push(`/notebooks/${item.id}`)}
                        onLongPress={() => setPendingDelete(item)}
                    />
                )}
                empty={{
                    icon: 'Book',
                    title: search ? t('notebooks.no_matches', 'No matches') : t('notebooks.create_first', 'Create your first notebook'),
                    message: search
                        ? t('notebooks.no_matches_hint', 'No notebooks match your search or filter. Try different terms, or clear the filter.')
                        : t(
                              'notebooks.empty_hint_first',
                              'Upload PDFs, documents, and URLs — then chat with your sources and generate summaries, briefings, and more.',
                          ),
                    actionLabel: search ? undefined : t('notebooks.new_notebook', 'New Notebook'),
                    onAction: search ? undefined : () => setCreating(true),
                }}
            />

            <AddFab label={t('notebooks.new_notebook', 'New Notebook')} onPress={() => setCreating(true)} />

            <NewNotebookSheet
                visible={creating}
                onClose={() => setCreating(false)}
                onCreated={(notebook) => {
                    setCreating(false);
                    if (notebook?.id) router.push(`/notebooks/${notebook.id}`);
                }}
            />

            <DeleteNotebookSheet notebook={pendingDelete} onDone={() => setPendingDelete(null)} />
        </Screen>
    );
}
