/**
 * One source, opened on its documents — the web's SourceDetail: every file
 * the source read, what became of each (the status column is the point: a
 * file that failed is a row that says so, not a missing row), filtered by
 * the web's four chips and searchable by title, paged as the list scrolls.
 *
 * Read-only on purpose: removing a file is done at the source it came from,
 * or from the Documents tab.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, EmptyState, ErrorState, FilterPills, InsetDivider, ListSkeleton, SearchField, Sheet, Spinner, Text, type FilterPillOption } from '@/shared/ui';

import { SourceDocRow } from './SourceDocRow';
import { useSourceDocuments } from '../hooks/sources';
import { hasUnscanned, sourceDocCounts, type SourceDocFilter } from '../model/sourceDocuments';
import { sourceSubline } from '../model/sources';
import type { KbDocument, KbSource } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        head: { gap: theme.spacing.sm, paddingBottom: theme.spacing.sm },
        foot: { gap: theme.spacing.sm, paddingVertical: theme.spacing.md },
        list: { flex: 1 },
    });

function chips(t: TranslateFn, source: KbSource): FilterPillOption<SourceDocFilter>[] {
    const n = sourceDocCounts(source);
    return [
        { value: 'all', label: t('knowledge.docs.filter_all', 'All'), count: n.all },
        { value: 'processed', label: t('knowledge.docs.filter_processed', 'Processed'), count: n.processed },
        { value: 'skipped', label: t('knowledge.docs.filter_skipped', 'Skipped'), count: n.skipped, tone: n.skipped ? 'warning' : undefined },
        { value: 'pii', label: t('knowledge.docs.filter_pii', 'With personal data'), count: n.pii },
    ];
}

const renderDoc = ({ item }: { item: KbDocument }) => <SourceDocRow doc={item} />;

export function SourceDocumentsSheet({ kbId, source, onClose }: { kbId: string; source: KbSource | null; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [filter, setFilter] = useState<SourceDocFilter>('all');
    const [draft, setDraft] = useState('');
    const [q, setQ] = useState('');
    const query = useSourceDocuments(kbId, source?.id ?? null, filter, q);
    if (!source) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
    const docs = query.data?.pages.flatMap((p) => p.documents) ?? [];
    const search = (text: string) => {
        setDraft(text);
        if (!text.trim()) setQ('');
    };
    return (
        <Sheet visible onClose={onClose} title={source.name || sourceSubline(t, source)} subtitle={sourceSubline(t, source)} scroll={false} tall>
            <View style={styles.head}>
                <FilterPills scroll value={filter} onChange={setFilter} options={chips(t, source)} accessibilityLabel={t('knowledge.docs.filter_label', 'Filter documents')} />
                <SearchField value={draft} onChangeText={search} onSubmit={() => setQ(draft)} placeholder={t('knowledge.docs.search', 'Search a file…')} />
            </View>
            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : (
                <FlatList
                    style={styles.list}
                    data={docs}
                    keyExtractor={(d) => d.id}
                    renderItem={renderDoc}
                    ItemSeparatorComponent={InsetDivider}
                    onEndReached={() => {
                        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
                    }}
                    ListEmptyComponent={<EmptyState icon="FileText" title={t('knowledge.docs.empty', 'Nothing here yet.')} />}
                    ListFooterComponent={
                        <View style={styles.foot}>
                            {query.isFetchingNextPage ? <Spinner /> : null}
                            {hasUnscanned(docs) ? (
                                <Banner tone="warning">{t('knowledge.docs.unchecked_note', 'Some of these were stored without being checked for personal data — the checker was unavailable or the document was too large. They are checked again on the next refresh.')}</Banner>
                            ) : null}
                            <Text variant="caption" tone="tertiary">
                                {t('knowledge.docs.redacted_note', '“Shielded” means personal data (name, address, IBAN) was replaced before the text entered the knowledge base. The AI knows the terms, not the customer.')}
                            </Text>
                        </View>
                    }
                    testID="source-documents"
                />
            )}
        </Sheet>
    );
}
