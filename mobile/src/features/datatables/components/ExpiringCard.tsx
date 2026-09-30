/**
 * "About to expire" — how many rows the retention sweep takes in the next
 * week (the second card of the web's RetentionPanel): the number that turns a
 * retention setting from a policy into a decision.
 *
 * COUNTED, not estimated (see countExpiringRows), and "500+" rather than a
 * number it cannot stand behind. A failed count says so; it never reads as
 * "nothing expires". With no window, the same figure dimmed: 0, nothing
 * expires on its own. Last, the copy people are surprised by: a run keeps
 * its own copy of the rows it read.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Section, Spinner, Text } from '@/shared/ui';

import { useExpiringRows } from '../hooks/queries';
import { EXPIRING_WITHIN_DAYS, retentionFieldLabel } from '../model/retention';
import type { Column, Datatable } from '../model/types';

function Figure({ table }: { table: Datatable }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const expiring = useExpiringRows(table);
    if (!table.retentionDays || !table.retentionField) {
        return (
            <View style={styles.figure}>
                <Text variant="title" tone="tertiary">0</Text>
                <Text variant="caption" tone="secondary" style={styles.shrink}>{t('datatables.expiring_none_set', 'rows — nothing expires on its own')}</Text>
            </View>
        );
    }
    if (expiring.isLoading) {
        return (
            <View style={styles.figure}>
                <Spinner />
                <Text variant="caption" tone="tertiary">{t('datatables.loading', 'Loading…')}</Text>
            </View>
        );
    }
    if (!expiring.data) {
        return <Text variant="caption" tone="warning">{t('datatables.expiring_failed', 'Could not work out what is about to expire.')}</Text>;
    }
    const { count, more } = expiring.data;
    return (
        <View style={styles.figure}>
            <Text variant="title" testID="expiring-count">{more ? t('datatables.expiring_at_least', '{n}+', { n: count }) : count.toLocaleString()}</Text>
            <Text variant="caption" tone="secondary" style={styles.shrink}>{t('datatables.expiring_body', 'rows expire in the next {n} days', { n: EXPIRING_WITHIN_DAYS })}</Text>
        </View>
    );
}

export function ExpiringCard({ table, columns }: { table: Datatable; columns: readonly Column[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const on = !!table.retentionDays && !!table.retentionField;
    return (
        <Section title={t('datatables.expiring_title', 'About to expire')}>
            <Card>
                <View style={styles.body}>
                    <View accessibilityLiveRegion="polite">
                        <Figure table={table} />
                    </View>
                    <Text variant="label" tone="tertiary">
                        {t('datatables.retention_runs', 'A run that read these rows keeps its own copy in its run history, which ages out on the run-history window instead.')}
                    </Text>
                    {on ? (
                        <Text variant="label" tone="tertiary">
                            {t('datatables.expiring_counted_from', 'Counted from {field}.', { field: retentionFieldLabel(t, columns, table.retentionField) })}
                        </Text>
                    ) : null}
                </View>
            </Card>
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.sm } satisfies ViewStyle,
    figure: { flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm } satisfies ViewStyle,
    shrink: { flexShrink: 1 },
});
