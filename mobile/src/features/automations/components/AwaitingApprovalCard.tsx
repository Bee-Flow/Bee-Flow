/** Approve or reject the step a paused run is waiting on. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { InlineMarkdown } from '@/shared/markdown';
import { Button, Card, Text, useToast } from '@/shared/ui';

import { StatusIcon } from './StatusPill';
import { useDecideRunStep } from '../hooks/mutations';
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
    const { toast } = useToast();
    const mutation = useDecideRunStep(run.id, onDecided, {
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.heading}>
                    <StatusIcon status={run.status} />
                    <Text variant="subheading" style={styles.title}>
                        Waiting for your decision
                    </Text>
                </View>
                <InlineMarkdown
                    variant="caption"
                    tone="tertiary"
                    value={run.summary ?? 'This run paused at a step that needs a person to say yes before it continues.'}
                />
                {run.awaitingStepExpiresAt ? (
                    <Text variant="caption" tone="warning">
                        Expires {absoluteTime(run.awaitingStepExpiresAt).toLowerCase()}
                    </Text>
                ) : null}
                <View style={styles.actions}>
                    <Button
                        label="Approve"
                        onPress={() => mutation.mutate('approve')}
                        loading={mutation.isPending}
                        style={styles.action}
                    />
                    <Button
                        label="Reject"
                        variant="danger"
                        onPress={() => mutation.mutate('reject')}
                        disabled={mutation.isPending}
                        style={styles.action}
                    />
                </View>
            </View>
        </Card>
    );
}
