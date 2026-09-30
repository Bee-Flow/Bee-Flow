/**
 * PDFs the document-renderer produced. They live in the server's temp
 * directory and expire; there is no delete endpoint and no upload, so this
 * tab offers exactly what exists: open and share.
 */

import React, { useMemo } from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatBytes } from '@/shared/lib/bytes';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, Icon, ListRow, ListSkeleton, Text } from '@/shared/ui';

import type { useRenderedDocuments } from '../hooks/queries';
import type { RenderedDocument } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        note: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        content: { paddingBottom: 96 },
    });

export function GeneratedDocumentList({
    generated,
    search,
    onOpen,
}: {
    generated: ReturnType<typeof useRenderedDocuments>;
    search: string;
    onOpen: (doc: RenderedDocument) => void;
}) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const refresh = useUserRefresh(() => generated.refetch());
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    const rows = useMemo(() => {
        const all = generated.data ?? [];
        const needle = search.trim().toLowerCase();
        return needle ? all.filter((doc) => doc.name.toLowerCase().includes(needle)) : all;
    }, [generated.data, search]);

    if (generated.isLoading) return <ListSkeleton />;
    if (generated.isError) {
        return <ErrorState error={generated.error} onRetry={() => void generated.refetch()} />;
    }

    return (
        <FlatList
            data={rows}
            keyExtractor={(doc) => doc.id}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListHeaderComponent={
                <Text variant="label" tone="tertiary" style={styles.note}>
                    PDFs Bee Flow rendered for you. They are temporary — download anything you
                    want to keep.
                </Text>
            }
            ListEmptyComponent={
                <EmptyState
                    icon="Printer"
                    title={search ? 'Nothing matches that' : 'Nothing rendered yet'}
                    message="When an agent or an automation produces a PDF, it shows up here until it expires."
                />
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <ListRow
                    title={item.name}
                    subtitle={formatBytes(item.sizeBytes)}
                    meta={timeAgo(item.createdAt)}
                    wrapTitle
                    leading={<Icon name="File" size={18} color={theme.colors.textMuted} />}
                    onPress={() => onOpen(item)}
                />
            )}
        />
    );
}
