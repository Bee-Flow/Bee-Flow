/**
 * "Sources" — where a knowledge base's material comes from and how each part
 * keeps itself up to date (the web's SourcesTab). Tap a source to see its
 * documents, refresh it, change its schedule, rename or delete it.
 */

import React, { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, InsetDivider, ListSkeleton, Text } from '@/shared/ui';

import { SourceDocumentsSheet } from './SourceDocumentsSheet';
import { SourceRow } from './SourceRow';
import { SourceSheet } from './SourceSheet';
import { useKbSources } from '../hooks/sources';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        head: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, gap: theme.spacing.xs },
        content: { paddingBottom: 96 },
    });

export function SourcesTab({ kbId, canManage, onAdd }: { kbId: string; canManage: boolean; onAdd?: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const query = useKbSources(kbId);
    const refresh = useUserRefresh(() => query.refetch());
    const [openId, setOpenId] = useState<string | null>(null);
    const [docsId, setDocsId] = useState<string | null>(null);
    if (query.isLoading) return <ListSkeleton />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    const sources = query.data?.sources ?? [];
    const open = sources.find((s) => s.id === openId) ?? null;
    const docsOf = sources.find((s) => s.id === docsId) ?? null;
    return (
        <>
            <FlatList
                data={sources}
                keyExtractor={(s) => s.id}
                renderItem={({ item }) => <SourceRow source={item} onPress={() => setOpenId(item.id)} />}
                ItemSeparatorComponent={InsetDivider}
                refreshControl={
                    <RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColor={theme.colors.accentPrimary} colors={[theme.colors.accentPrimary]} />
                }
                ListHeaderComponent={
                    <View style={styles.head}>
                        <Text variant="caption" tone="tertiary">
                            {t('knowledge.sources.privacy_note', 'Whoever may see this knowledge base also sees what the AI quotes from it. Sources containing personal data are marked by Privacy Shield automatically.')}
                        </Text>
                    </View>
                }
                ListEmptyComponent={
                    <EmptyState
                        icon="Layers"
                        title={t('mobile.knowledge.no_sources', 'No sources yet')}
                        message={t('mobile.knowledge.sources_empty', 'Add one and it keeps itself up to date from then on.')}
                        actionLabel={canManage && onAdd ? t('knowledge.add_source', 'Add a source') : undefined}
                        onAction={canManage ? onAdd : undefined}
                    />
                }
                contentContainerStyle={styles.content}
            />
            <SourceSheet key={openId ?? 'none'} kbId={kbId} source={open} canManage={canManage} onClose={() => setOpenId(null)}
                onDocuments={() => {
                    setOpenId(null);
                    setDocsId(openId);
                }} />
            <SourceDocumentsSheet key={`docs:${docsId ?? 'none'}`} kbId={kbId} source={docsOf} onClose={() => setDocsId(null)} />
        </>
    );
}
