/**
 * A schedule's past runs. Bounded by the server (25 by default), so the
 * section maps its rows. Each shows the run's own text, not a generic line:
 * the notification body already carried the whole result, and this is the
 * same thing.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow, Section, Text } from '@/shared/ui';

import type { CoworkRun } from '../model/types';

function RunLine({ run }: { run: CoworkRun }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const failed = run.status === 'failed';
    return (
        <ListRow
            title={failed ? 'Failed' : 'Completed'}
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
    return (
        <Section title="History" subtitle={runCount === 1 ? 'Ran once' : `Ran ${runCount} times`}>
            {runs && runs.length > 0 ? (
                runs.map((r, i) => <RunLine key={r.id ?? i} run={r} />)
            ) : (
                <Text variant="caption" tone="tertiary">
                    Nothing has run yet.
                </Text>
            )}
        </Section>
    );
}
