/**
 * A schedule's past runs. Bounded by the server (25 by default), so the
 * section maps its rows. Each shows the run's own text, not a generic line:
 * the notification body already carried the whole result, and this is the
 * same thing.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Icon, ListRow, Section, Text } from '@/shared/ui';

import type { CoworkRun } from '../model/types';

function RunLine({ run }: { run: CoworkRun }) {
    const t = useTranslation(); // also re-renders when the language changes: timeAgo speaks it
    const theme = useTheme();
    const failed = run.status === 'failed';
    return (
        <ListRow
            title={failed ? t('run_status.error', 'Failed') : t('tasks.completed', 'Completed')}
            subtitle={run.error ?? run.result ?? undefined}
            wrapTitle
            meta={timeAgo(run.finishedAt ?? run.startedAt ?? run.createdAt)}
            leading={
                <Icon
                    name={failed ? 'CircleAlert' : 'Check'}
                    size={16}
                    color={failed ? theme.colors.error : theme.colors.success}
                />
            }
        />
    );
}

export function ScheduleHistory({ runCount, runs }: { runCount: number; runs: CoworkRun[] | undefined }) {
    const t = useTranslation();
    return (
        <Section
            title={t('documents.history', 'History')}
            subtitle={nOf(t, 'mobile.cowork.ran', runCount, ['Ran once', 'Ran {count} times'])}
        >
            {runs && runs.length > 0 ? (
                runs.map((r, i) => <RunLine key={r.id ?? i} run={r} />)
            ) : (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.cowork.nothing_ran', 'Nothing has run yet.')}
                </Text>
            )}
        </Section>
    );
}
