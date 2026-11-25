/**
 * A schedule's past runs. Bounded by the server (25 by default), so the
 * section maps its rows. Each shows the run's own text, not a generic line:
 * the notification body already carried the whole result, and this is the
 * same thing. A tap opens a row, and only then is its receipt read.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Icon, ListRow, Section, Text } from '@/shared/ui';

import { ReceiptNote } from './ReceiptNote';
import type { CoworkRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        opened: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm, gap: theme.spacing.xs },
    });

/** A run's title, icon and tone: failed, waiting for its owner, or done. */
function runLook(run: CoworkRun, t: TranslateFn, theme: Theme) {
    if (run.status === 'failed') {
        return { title: t('run_status.error', 'Failed'), icon: 'CircleAlert', color: theme.colors.error } as const;
    }
    if (run.status === 'incomplete') {
        return { title: t('cowork_resolver.status.incomplete', 'Did not do its work'), icon: 'CircleAlert', color: theme.colors.error } as const;
    }
    if (run.status === 'needs_review') {
        return { title: t('cowork_review.status.needs_review', 'Needs review'), icon: 'Clock', color: theme.colors.warningInk } as const;
    }
    return { title: t('tasks.completed', 'Completed'), icon: 'Check', color: theme.colors.success } as const;
}

function RunLine({ scheduleId, run }: { scheduleId: string; run: CoworkRun }) {
    const t = useTranslation(); // also re-renders when the language changes: timeAgo speaks it
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const look = runLook(run, t, theme);
    const text = run.error ?? run.result ?? undefined;
    return (
        <View>
            <ListRow
                title={look.title}
                subtitle={open ? undefined : text}
                wrapTitle
                meta={timeAgo(run.finishedAt ?? run.startedAt ?? run.createdAt)}
                chevron={false}
                onPress={run.id ? () => setOpen((v) => !v) : undefined}
                leading={<Icon name={look.icon} size={16} color={look.color} />}
            />
            {open && run.id ? (
                <View style={styles.opened}>
                    {text ? (
                        <Text variant="caption" tone="secondary" selectable>
                            {text}
                        </Text>
                    ) : null}
                    <ReceiptNote scheduleId={scheduleId} runId={run.id} />
                </View>
            ) : null}
        </View>
    );
}

export function ScheduleHistory({
    scheduleId,
    runCount,
    runs,
}: {
    scheduleId: string;
    runCount: number;
    runs: CoworkRun[] | undefined;
}) {
    const t = useTranslation();
    return (
        <Section
            title={t('documents.history', 'History')}
            subtitle={nOf(t, 'mobile.cowork.ran', runCount, ['Ran once', 'Ran {count} times'])}
        >
            {runs && runs.length > 0 ? (
                runs.map((r, i) => <RunLine key={r.id ?? i} scheduleId={scheduleId} run={r} />)
            ) : (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.cowork.nothing_ran', 'Nothing has run yet.')}
                </Text>
            )}
        </Section>
    );
}
