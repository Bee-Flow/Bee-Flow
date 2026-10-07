/**
 * AI Act › Systems — the web's PerAutomationTab, for touch: every agent and
 * automation with a saved declaration, its outcome, when it was attested and
 * how long it holds. Tapping a row opens the ladder for it (Reassess once lapsed).
 */

import React, { useState } from 'react';
import { FlatList } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Badge, EmptyState, Icon, ListRow, LoadingState } from '@/shared/ui';

import type { AiActAssessmentRow, AiActKind } from '../api';
import { useAiActAssessments } from '../hooks';
import { AiActLadderSheet } from './AiActLadderSheet';
import { systemRowWords } from '../model/systems';


const rowKey = (r: AiActAssessmentRow) => `${r.kind}:${r.id}`;

function SystemRow({ row, onOpen }: { row: AiActAssessmentRow; onOpen: (row: AiActAssessmentRow) => void }) {
    const t = useTranslation();
    const words = systemRowWords(row, t);
    return (
        <ListRow
            leading={<Icon name={words.icon} size={18} />}
            title={words.title}
            subtitle={`${words.kind} · ${words.line}`}
            meta={words.action}
            trailing={<Badge label={words.outcome.label} tone={words.outcome.tone} testID="ai-systems-outcome" />}
            onPress={() => onOpen(row)}
            testID={`ai-systems-row-${rowKey(row)}`}
        />
    );
}

export function AiSystemsList({ enabled = true }: { enabled?: boolean }) {
    const t = useTranslation();
    const query = useAiActAssessments(enabled);
    const [open, setOpen] = useState<{ kind: AiActKind; id: string } | null>(null);
    if (query.isPending && enabled) return <LoadingState />;
    if (query.isError) {
        return (
            <EmptyState
                icon="TriangleAlert"
                title={t('compliance.fw_pa_read_failed', 'The AI Act assessments could not be read.')}
            />
        );
    }
    return (
        <>
            <FlatList
                data={query.data ?? []}
                keyExtractor={rowKey}
                renderItem={({ item }) => <SystemRow row={item} onOpen={(r) => setOpen({ kind: r.kind, id: r.id })} />}
                refreshing={query.isRefetching}
                onRefresh={() => void query.refetch()}
                accessibilityLabel={t('compliance.tab_aia_systems', 'Systems')}
                ListEmptyComponent={
                    <EmptyState
                        title={t('compliance.fw_pa_empty_title', 'No assessments yet')}
                        message={t('compliance.fw_pa_empty_desc', 'Run the AI Act ladder on an agent or automation — the outcome lands here with its expiry.')}
                    />
                }
                testID="ai-systems-list"
            />
            {open ? <AiActLadderSheet kind={open.kind} id={open.id} onClose={() => setOpen(null)} /> : null}
        </>
    );
}
