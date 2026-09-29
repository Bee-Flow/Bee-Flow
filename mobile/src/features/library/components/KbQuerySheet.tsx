/**
 * Ask a knowledge base a question and see exactly what comes back.
 *
 * This is deliberately NOT a chat. It runs the same retrieval an agent runs
 * (POST /api/kb/search) and shows the raw matched chunks, because the question
 * it answers is "is the right thing in here?" — and a fluent model answer is
 * the worst possible way to check that.
 *
 * Scores are shown as a bar relative to the best hit in the same result set,
 * never as a percentage. The number is a reciprocal-rank fusion score from
 * searchLocally (server/core/kb/localKBIngest.js): comparable within one
 * query, meaningless as an absolute. A "68% match" badge would be invented.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation } from '@tanstack/react-query';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { EmptyState, ErrorState, LoadingState } from '../../../ui/Feedback';
import { SearchField } from '../../../ui/Input';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { searchKnowledgeBases } from '../api';
import { condense, relativeScore } from '../format';
import type { KbSearchHit } from '../types';

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
    const theme = useTheme();
    const [query, setQuery] = useState('');

    const run = useMutation({
        mutationFn: (q: string) => searchKnowledgeBases(q, kbId ? [kbId] : [], 8),
    });

    const hits = run.data ?? [];
    const best = hits.reduce((max, h) => Math.max(max, h.score ?? 0), 0);

    const submit = () => {
        const q = query.trim();
        if (q.length < 2) return;
        run.mutate(q);
    };

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
            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
                <SearchField
                    value={query}
                    onChangeText={setQuery}
                    placeholder="What are you looking for?"
                    onSubmit={submit}
                    autoFocus
                />
            </View>

            <View style={{ flexShrink: 1 }}>
                {run.isPending ? (
                    <LoadingState label="Searching…" />
                ) : run.isError ? (
                    <ErrorState error={run.error} onRetry={submit} />
                ) : !run.isSuccess ? (
                    <View style={{ paddingHorizontal: theme.spacing.lg }}>
                        <Text variant="caption" tone="tertiary">
                            Retrieval runs on your server. You will see the exact passages an agent
                            would be given, in the order it would get them.
                        </Text>
                    </View>
                ) : hits.length === 0 ? (
                    <EmptyState
                        icon="search"
                        title="Nothing matched"
                        message="Try different words, or check that the documents you expect have finished indexing."
                    />
                ) : (
                    <ScrollView
                        contentContainerStyle={{
                            paddingHorizontal: theme.spacing.lg,
                            paddingBottom: theme.spacing.lg,
                            gap: theme.spacing.md,
                        }}
                    >
                        <Text variant="label" tone="tertiary" accessibilityLiveRegion="polite">
                            {hits.length} PASSAGE{hits.length === 1 ? '' : 'S'}
                        </Text>
                        {hits.map((hit, i) => (
                            <HitCard key={`${hit.id}-${i}`} hit={hit} rank={i + 1} best={best} />
                        ))}
                    </ScrollView>
                )}
            </View>
        </Sheet>
    );
}

function HitCard({ hit, rank, best }: { hit: KbSearchHit; rank: number; best: number }) {
    const theme = useTheme();
    const strength = relativeScore(hit.score ?? 0, best);

    return (
        <View
            style={{
                borderRadius: theme.radii.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.borderSubtle,
                backgroundColor: theme.colors.bgCard,
                padding: theme.spacing.md,
                gap: theme.spacing.sm,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Text variant="label" tone="accent">
                    #{rank}
                </Text>
                <Text variant="caption" weight="medium" numberOfLines={1} style={{ flex: 1 }}>
                    {hit.title || 'Untitled passage'}
                </Text>
            </View>

            <View
                accessibilityLabel={`Match strength ${Math.round(strength * 100)} percent of the best result`}
                style={{
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: theme.colors.bgTertiary,
                    overflow: 'hidden',
                }}
            >
                <View
                    style={{
                        width: `${Math.max(4, Math.round(strength * 100))}%`,
                        height: '100%',
                        backgroundColor: theme.colors.accentPrimary,
                    }}
                />
            </View>

            <Text variant="caption" tone="secondary" selectable>
                {condense(hit.content, 400)}
            </Text>

            {hit.source_uri ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
                    <Feather name="link" size={11} color={theme.colors.textMuted} />
                    <Text variant="label" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
                        {hit.source_uri}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}
