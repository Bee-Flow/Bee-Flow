/**
 * The Used-by tab — the one surface that answers "what would that break"
 * before a column is dropped or the table deleted (the web's UsedByTab over
 * DatatableDetail.adaptRow). One row per SITE: an automation with two Datatable
 * steps on this table appears twice. A consumer that is someone else's has no
 * title and no link; the caller's own open on the phone.
 */

import { useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { useCurrentUser } from '@/core/auth/AuthProvider';
import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { useUserRefresh } from '@/shared/patterns';
import { DataList, EmptyState, ErrorState, kindLabel, LoadingState, Text, type DataColumn } from '@/shared/ui';

import { useDatatableUsage } from '../hooks/queries';
import type { UsageRow } from '../model/types';
import { siteText } from '../model/words';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ root: { flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md }, where: { gap: 2 } });

/** Where each kind of consumer opens on the phone. */
const ROUTE_OF: Readonly<Record<string, string>> = {
    automation: '/automations',
    app: '/apps',
    webpage: '/webpages',
    kb: '/knowledge',
};

function roleText(t: TranslateFn, mode: UsageRow['mode']): string {
    if (mode === 'readwrite') return t('usage.role_readwrite', 'reads and writes');
    return mode === 'write' ? t('usage.role_write', 'writes') : t('usage.role_read', 'reads');
}

const keyOf = (row: UsageRow, i: number) => `${i}:${row.consumerKind}:${row.consumerId}`;

export function UsageTab({ tableId }: { tableId: string }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    const me = useCurrentUser().id;
    const usage = useDatatableUsage(tableId);
    const refresh = useUserRefresh(() => usage.refetch());
    const mine = useCallback((row: UsageRow) => row.ownerId === me && !!ROUTE_OF[row.consumerKind], [me]);
    const open = useCallback(
        (row: UsageRow) => (mine(row) ? openRoute(router, `${ROUTE_OF[row.consumerKind]}/${row.consumerId}`) : undefined),
        [mine, router],
    );

    if (usage.isLoading) return <LoadingState label={t('usage.loading', 'Loading who uses this…')} />;
    if (usage.isError) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;

    const columns: DataColumn<UsageRow>[] = [
        {
            id: 'where',
            label: t('usage.head_where', 'Where'),
            flex: 2,
            render: (row) => {
                const kind = kindLabel(t, row.consumerKind, 1);
                return (
                    <View style={styles.where}>
                        <Text variant="caption" weight="medium" numberOfLines={1}>
                            {row.title || t('usage.someone_elses_kind', 'Someone else’s {kind}', { kind })}
                        </Text>
                        <Text variant="label" tone="tertiary" numberOfLines={1}>
                            {[kind, siteText(t, row)].filter(Boolean).join(' · ')}
                        </Text>
                    </View>
                );
            },
        },
        { id: 'does', label: t('usage.head_does', 'Does'), flex: 1, render: (row) => roleText(t, row.mode) },
        { id: 'last', label: t('usage.head_last', 'Last time'), flex: 1, align: 'right', render: (row) => (row.lastRunAt ? timeAgo(row.lastRunAt) : '—') },
    ];

    return (
        <View style={styles.root}>
            <DataList
                columns={columns}
                rows={usage.data ?? []}
                rowKey={keyOf}
                onRowPress={open}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
                empty={<EmptyState icon="Workflow" title={t('datatables.usage_empty', 'No automation uses this table yet. Add a Datatable step to one and pick this table.')} />}
                testID="usage"
            />
            <Text variant="caption" tone="tertiary">
                {t('datatables.usage_hint', 'To connect another automation: add a Datatable step there and pick this table.')}
            </Text>
        </View>
    );
}
