/**
 * The server-side filters, as chips. "Processing" is first-class rather than a
 * detail: an ingestion that quietly failed is the single most common reason a
 * notebook answers badly.
 */

import React from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip } from '@/shared/ui';

import type { NotebookFilter } from '../api/endpoints';

const FILTERS: NotebookFilter[] = ['all', 'pinned', 'processing', 'sources', 'chat', 'empty'];

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexGrow: 0 },
        content: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
    });

export function NotebookFilterChips({
    filter,
    onChange,
}: {
    filter: NotebookFilter;
    onChange: (filter: NotebookFilter) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    // The web's own chip words (NotebooksOverview's filter menu).
    const labels: Record<NotebookFilter, string> = {
        all: t('notebooks.filter_all', 'All'),
        pinned: t('notebooks.filter_pinned', 'Pinned'),
        processing: t('notebooks.filter_processing', 'Processing'),
        sources: t('notebooks.filter_sources', 'Has sources'),
        chat: t('notebooks.filter_chat', 'Has chat'),
        empty: t('notebooks.filter_empty', 'Empty'),
    };
    return (
        <FlatList
            horizontal
            data={FILTERS}
            keyExtractor={(f) => f}
            showsHorizontalScrollIndicator={false}
            style={styles.row}
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <Chip label={labels[item]} selected={filter === item} onPress={() => onChange(item)} />
            )}
        />
    );
}
