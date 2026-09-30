/** A run's vital statistics: status, time taken, when, what started it. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Card } from '@/shared/ui';

import { RunFact } from './RunFact';
import { StatusBadge } from './StatusPill';
import { triggerText } from '../model/runWords';
import { absoluteTime, formatDuration } from '../model/time';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.sm } });

export function RunFacts({ run, elapsed }: { run: AutomationRun; elapsed: number | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Card>
            <View style={styles.body}>
                <RunFact label={t('common.status', 'Status')} value={<StatusBadge status={run.status} />} />
                <RunFact label={t('mobile.automations.fact.took', 'Took')} text={formatDuration(elapsed)} />
                <RunFact label={t('mobile.automations.fact.started', 'Started')} text={absoluteTime(run.startedAt)} />
                {run.finishedAt ? (
                    <RunFact label={t('mobile.automations.fact.finished', 'Finished')} text={absoluteTime(run.finishedAt)} />
                ) : null}
                <RunFact label={t('mobile.automations.fact.started_by', 'Started by')} text={triggerText(run.triggerKind, t)} />
                <RunFact label={t('mobile.automations.fact.version', 'Flow version')} text={String(run.version)} />
                {run.mode === 'dry_run' ? (
                    <RunFact
                        label={t('mobile.automations.fact.mode', 'Mode')}
                        value={<Badge label={t('mobile.runs.trigger.dry_run', 'Test run')} />}
                    />
                ) : null}
            </View>
        </Card>
    );
}
