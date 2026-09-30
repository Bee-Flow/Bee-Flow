/**
 * Ask a knowledge base a question and see exactly what comes back.
 *
 * Deliberately NOT a chat. It runs the same retrieval an agent runs
 * (POST /api/kb/search) and shows the raw matched chunks, because the question
 * it answers is "is the right thing in here?" — and a fluent model answer is
 * the worst possible way to check that.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, EmptyState, ErrorState, LoadingState, SearchField, Sheet, Text } from '@/shared/ui';

import { KbHitCard } from './KbHitCard';
import { useKbSearch } from '../hooks/mutations';
import type { KbSearchHit } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
        body: { flexShrink: 1 },
        intro: { paddingHorizontal: theme.spacing.lg },
        hits: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg, gap: theme.spacing.md },
    });

/** The top-k passages (8), best first. Bounded by the request, so a ScrollView. */
function KbHits({ hits }: { hits: KbSearchHit[] }) {
    const styles = useThemedStyles(makeStyles);
    const best = hits.reduce((max, h) => Math.max(max, h.score ?? 0), 0);
    return (
        <ScrollView contentContainerStyle={styles.hits}>
            <Text variant="label" tone="tertiary" accessibilityLiveRegion="polite">
                {hits.length} PASSAGE{hits.length === 1 ? '' : 'S'}
            </Text>
            {hits.map((hit, i) => (
                <KbHitCard key={`${hit.id}-${i}`} hit={hit} rank={i + 1} best={best} />
            ))}
        </ScrollView>
    );
}

export function KbQuerySheet({
    visible,
    onClose,
    kbId,
    kbName,
}: {
    visible: boolean;
    onClose: () => void;
    /** Omit for a search across every knowledge base the person can reach. */
    kbId?: string;
    kbName: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const [query, setQuery] = useState('');
    const run = useKbSearch(kbId);
    const hits = run.data ?? [];

    const submit = () => {
        const q = query.trim();
        if (q.length < 2) return;
        run.mutate(q);
    };

    let body: React.ReactNode;
    if (run.isPending) {
        body = <LoadingState label="Searching…" />;
    } else if (run.isError) {
        body = <ErrorState error={run.error} onRetry={submit} />;
    } else if (!run.isSuccess) {
        body = (
            <View style={styles.intro}>
                <Text variant="caption" tone="tertiary">
                    Retrieval runs on your server. You will see the exact passages an agent
                    would be given, in the order it would get them.
                </Text>
            </View>
        );
    } else if (hits.length === 0) {
        body = (
            <EmptyState
                icon="Search"
                title="Nothing matched"
                message="Try different words, or check that the documents you expect have finished indexing."
            />
        );
    } else {
        body = <KbHits hits={hits} />;
    }

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Query this knowledge base"
            subtitle={kbName}
            scroll={false}
            tall
            footer={
                <Button
                    label="Search"
                    fullWidth
                    onPress={submit}
                    loading={run.isPending}
                    disabled={query.trim().length < 2}
                />
            }
        >
            <View style={styles.search}>
                <SearchField
                    value={query}
                    onChangeText={setQuery}
                    placeholder="What are you looking for?"
                    onSubmit={submit}
                    autoFocus
                />
            </View>
            <View style={styles.body}>{body}</View>
        </Sheet>
    );
}
