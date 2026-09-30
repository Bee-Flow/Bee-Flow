/**
 * What an upgrade would do, in the five groups someone reads before they
 * confirm (the web's PlanBody), and what it did afterwards (ReportBody).
 * "Stays as it is, unchecked" is its own group: a table or knowledge base is
 * never rewritten, and saying it was compared would be a lie.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { Strip } from './Strip';
import type { PlanRow, PlanRows, UpgradeReport } from '../model/package';
import { byCount } from '../model/words';

function Group({ rows, title, note }: { rows: PlanRow[]; title: string; note?: string }) {
    const styles = useThemedStyles(makeStyles);
    if (rows.length === 0) return null;
    return (
        <View style={styles.group}>
            <Text variant="subheading">{title}</Text>
            {note ? (
                <Text variant="caption" tone="tertiary">
                    {note}
                </Text>
            ) : null}
            {rows.map((row, i) => (
                <Text key={`${row.ref}-${i}`} variant="body" tone="secondary" style={styles.item}>
                    {row.name}
                </Text>
            ))}
        </View>
    );
}

export function PlanView({ rows }: { rows: PlanRows }) {
    const t = useTranslation();
    const c = { count: rows.changed.length };
    const a = { count: rows.added.length };
    const k = { count: rows.kept.length };
    const u = { count: rows.undetermined.length };
    const g = { count: rows.gone.length };
    return (
        <>
            <Group
                rows={rows.changed}
                title={byCount(c.count, t('solutions.upgrade_changed', '{count} thing is replaced by the new version', c), t('solutions.upgrade_changed_plural', '{count} things are replaced by the new version', c))}
                note={t('solutions.upgrade_changed_note', 'You have not touched these since you installed them.')}
            />
            <Group rows={rows.added} title={byCount(a.count, t('solutions.upgrade_added', '{count} thing is added', a), t('solutions.upgrade_added_plural', '{count} things are added', a))} />
            <Group
                rows={rows.kept}
                title={byCount(k.count, t('solutions.upgrade_kept', '{count} thing you changed stays as it is', k), t('solutions.upgrade_kept_plural', '{count} things you changed stay as they are', k))}
                note={t('solutions.upgrade_kept_note', 'Your version is kept — the update does not write over it.')}
            />
            <Group
                rows={rows.undetermined}
                title={byCount(u.count, t('solutions.upgrade_undetermined', '{count} thing stays as it is', u), t('solutions.upgrade_undetermined_plural', '{count} things stay as they are', u))}
                note={t('solutions.upgrade_undetermined_note', 'These are left as they are without checking whether you changed them — a table or knowledge base is never rewritten because it holds live data, and anything the update could not read is left alone rather than guessed at. This is not a statement that you did not change them.')}
            />
            <Group
                rows={rows.gone}
                title={byCount(g.count, t('solutions.upgrade_gone', '{count} thing you deleted is not brought back', g), t('solutions.upgrade_gone_plural', '{count} things you deleted are not brought back', g))}
                note={t('solutions.upgrade_gone_note', 'These were installed once and are gone now. Deleting them was a decision, so the update leaves them out.')}
            />
        </>
    );
}

export function ReportView({ report }: { report: UpgradeReport }) {
    const t = useTranslation();
    const failed = report.failed.map((f) => f.why).filter(Boolean).join(' · ');
    return (
        <>
            <Text variant="body" testID="upgrade-report">
                {t('solutions.upgrade_done', 'Updated. {replaced} replaced, {added} added.', { replaced: report.replaced, added: report.added })}
            </Text>
            {report.failed.length > 0 ? (
                <Strip tone="error" detail={failed || null}>
                    {t('solutions.upgrade_failed_some', 'Some of it did not go through:')}
                </Strip>
            ) : null}
            {report.warnings.map((w, i) => (
                <Text key={`w-${i}`} variant="caption" tone="tertiary">
                    {w}
                </Text>
            ))}
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    group: { gap: theme.spacing.xs } satisfies ViewStyle,
    item: { paddingLeft: theme.spacing.sm } satisfies ViewStyle,
});
