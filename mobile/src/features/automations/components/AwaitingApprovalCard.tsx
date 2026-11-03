/**
 * Approve or reject the step a paused run is waiting on. The decision goes
 * through useRunDecision: an approval that asks for answers opens the
 * approvals screen, and a panel vote is told as a vote.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { InlineMarkdown } from '@/shared/markdown';
import { runPhase } from '@/shared/runs/runPhase';
import { Badge, Button, Card, Text } from '@/shared/ui';

import { StatusIcon } from './StatusPill';
import { useRunDecision } from '../hooks/useRunDecision';
import { absoluteTime } from '../model/time';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
        heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
        action: { flex: 1 },
    });

export function AwaitingApprovalCard({ run, onDecided }: { run: AutomationRun; onDecided: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const decision = useRunDecision(run, onDecided);

    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.heading}>
                    <StatusIcon status={run.status} />
                    {runPhase(run).isTest ? <Badge label={t('mobile.runs.test_marker', 'Test')} tone="ai" /> : null}
                    <Text variant="subheading" style={styles.title}>
                        {t('mobile.automations.approval.waiting', 'Waiting for your decision')}
                    </Text>
                </View>
                <InlineMarkdown
                    variant="caption"
                    tone="tertiary"
                    value={
                        run.summary ??
                        t('mobile.automations.approval.default_summary', 'This run paused at a step that needs a person to say yes before it continues.')
                    }
                />
                {run.awaitingStepExpiresAt ? (
                    <Text variant="caption" tone="warning">
                        {t('mobile.automations.approval.expires', 'Expires {time}', {
                            time: absoluteTime(run.awaitingStepExpiresAt).toLowerCase(),
                        })}
                    </Text>
                ) : null}
                <View style={styles.actions}>
                    <Button
                        label={t('approvals.approve', 'Approve')}
                        onPress={() => decision.decide('approve')}
                        loading={decision.pending}
                        disabled={decision.checking}
                        style={styles.action}
                    />
                    <Button
                        label={t('approvals.reject', 'Reject')}
                        variant="danger"
                        onPress={() => decision.decide('reject')}
                        disabled={decision.pending}
                        style={styles.action}
                    />
                </View>
            </View>
        </Card>
    );
}
