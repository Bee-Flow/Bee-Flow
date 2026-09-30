/**
 * The Retention tab — how long the rows are kept, and what that means (the
 * web's RetentionPanel, "Tab · Bewaartermijn"): the window with the date
 * column it counts from, and how much of the table is about to go.
 *
 * The columns are read before anything is drawn, so the column picker starts
 * on a real date column instead of an empty one it would have to send.
 *
 * A linked table (a mirror) has no such tab — its rows are its source's, and
 * the server refuses it a window. Reached by address anyway, it says why.
 */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, ErrorState, LoadingState } from '@/shared/ui';

import { ExpiringCard } from './ExpiringCard';
import { RetentionCard } from './RetentionCard';
import { useDatatableSchema } from '../hooks/queries';
import { offersRetention } from '../model/retention';
import type { Datatable } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ content: { padding: theme.spacing.lg, gap: theme.spacing.xl, paddingBottom: theme.spacing.xxxl } });

function MirrorNotice({ table }: { table: Datatable }) {
    const t = useTranslation();
    return (
        <Banner tone="info" icon="Timer">
            {table.managedKind === 'nextcloud_table'
                ? t('datatables.nc_no_retention', 'Rows are not aged out here — they stay as long as they are in Nextcloud.')
                : t('datatables.ss_no_retention', 'Rows are not aged out here — they stay as long as they are in the file.')}
        </Banner>
    );
}

export function RetentionTab({ table, canEdit }: { table: Datatable; canEdit: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const schema = useDatatableSchema(table.id);
    const mirror = !offersRetention(table);

    if (!mirror && schema.isLoading) return <LoadingState label={t('datatables.loading', 'Loading…')} />;
    if (!mirror && !schema.data) return <ErrorState error={schema.error} onRetry={() => void schema.refetch()} />;
    const columns = schema.data?.fields ?? [];
    return (
        <ScrollView contentContainerStyle={styles.content} testID="datatable-retention">
            {mirror ? <MirrorNotice table={table} /> : null}
            {!mirror && table.managedKind === 'http_cache' ? (
                <Banner tone="warning" icon="ShieldAlert">
                    {t('datatables.managed_plaintext', 'Rows here hold what a third-party service answered, in plain text, readable and exportable by everyone with access to this table.')}
                </Banner>
            ) : null}
            {mirror ? null : <RetentionCard table={table} columns={columns} canEdit={canEdit} />}
            {mirror ? null : <ExpiringCard table={table} columns={columns} />}
        </ScrollView>
    );
}
