/**
 * The fill phase: the server runs the automation once so the table has real
 * rows. The web draws the flow executing on its canvas; the phone shows the
 * count as it grows (the page polls while the run lives) and opens the run
 * itself on the automation's own run screen, step by step.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

import { StageCard } from './StageCard';
import { artNum, artStr } from '../model/artifacts';
import { kindOf } from '../model/phaseMachine';
import type { Phase, Playbook } from '../model/types';

/** The automation this fill runs: the nearest routine phase before it (the server's routineBefore). */
function routineAutomationId(playbook: Playbook, key: string): string | null {
    const i = playbook.phases.findIndex((p) => p.key === key);
    for (let j = i - 1; j >= 0; j--) {
        const p = playbook.phases[j];
        if (p && kindOf(p) === 'routine') return artStr(p.artifacts, 'automationId');
    }
    return null;
}

function statusLine(phase: Phase, rows: number, t: ReturnType<typeof useTranslation>): string {
    if (phase.status === 'awaiting' || phase.status === 'done') return t('playbooks.fill.done', '{n} rows · done', { n: rows });
    if (phase.status === 'failed') return t('playbooks.fill.failed', 'The run failed');
    return artStr(phase.artifacts, 'runId') ? t('playbooks.fill.running', 'running') : t('playbooks.fill.starting', 'Starting the automation…');
}

export function FillStage({ playbook, phase }: { playbook: Playbook; phase: Phase }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const a = phase.artifacts;
    const rows = artNum(a, 'rowCount') ?? artNum(a, 'rowsBefore') ?? 0;
    const before = artNum(a, 'rowsBefore');
    const added = artNum(a, 'rowCount') !== null && before !== null ? rows - before : null;
    const landed = phase.status === 'awaiting' || phase.status === 'done';
    const runId = artStr(a, 'runId');
    const automationId = routineAutomationId(playbook, phase.key);
    const status = statusLine(phase, rows, t);
    return (
        <StageCard
            kind="datatable"
            title={t('playbooks.fill.steps', 'The run, step by step')}
            status={status}
            tone={phase.status === 'failed' ? 'error' : landed ? 'quiet' : 'busy'}
            testID="playbook-stage-fill"
        >
            <View style={styles.counter}>
                <Text variant="title" testID="playbook-row-counter">
                    {String(rows)}
                </Text>
                <Text variant="caption" tone="secondary" style={styles.grow}>
                    {t('playbooks.fill.rows_so_far', 'rows in the table')}
                </Text>
                {landed && added !== null && added >= 0 ? (
                    <Text variant="caption" tone="success">
                        {t('playbooks.fill.added', '+{n} this run', { n: added })}
                    </Text>
                ) : null}
            </View>
            {runId && automationId ? (
                <Button
                    variant="secondary"
                    size="sm"
                    iconName="History"
                    label={t('mobile.playbooks.open_run', 'Open the run')}
                    onPress={() => router.push(`/automations/${encodeURIComponent(automationId)}/runs?runId=${encodeURIComponent(runId)}`)}
                />
            ) : null}
        </StageCard>
    );
}

const makeStyles = (theme: Theme) => ({
    counter: { flexDirection: 'row' as const, alignItems: 'baseline' as const, gap: theme.spacing[2] },
    grow: { flex: 1 },
});
