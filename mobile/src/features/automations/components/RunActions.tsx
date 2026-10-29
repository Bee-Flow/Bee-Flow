/**
 * The one thing a run's state lets you do: decide the step it waits on, stop
 * it while it moves, or run it again once it has settled.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

import { VIEW_ONLY_RUN_HINT } from '../model/runAccess';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        pair: { flexDirection: 'row', gap: theme.spacing.sm },
        half: { flex: 1 },
    });

interface Action<T = void> {
    run: (value: T) => void;
    pending: boolean;
}

export function RunActions({
    awaitingApproval,
    live,
    decide,
    stop,
    retry,
    canRetry = true,
}: {
    awaitingApproval: boolean;
    live: boolean;
    decide: Action<'approve' | 'reject'>;
    stop: Action;
    retry: Action;
    /** false when the server says this person may not start a run (a view share). */
    canRetry?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    if (awaitingApproval) {
        return (
            <View style={styles.pair}>
                <Button
                    label={t('approvals.approve', 'Approve')}
                    onPress={() => decide.run('approve')}
                    loading={decide.pending}
                    style={styles.half}
                />
                <Button
                    label={t('approvals.reject', 'Reject')}
                    variant="danger"
                    onPress={() => decide.run('reject')}
                    disabled={decide.pending}
                    style={styles.half}
                />
            </View>
        );
    }
    if (live) {
        return (
            <Button
                label={t('automations.run_progress_banner.stop_this_run', 'Stop this run')}
                variant="danger"
                fullWidth
                loading={stop.pending}
                onPress={() => stop.run()}
            />
        );
    }
    const hint = t('automations.run.viewOnlyHint', VIEW_ONLY_RUN_HINT);
    return (
        <>
            <Button
                label={t('studio_misc.runbar.run_again', 'Run it again')}
                variant="secondary"
                fullWidth
                loading={retry.pending}
                disabled={!canRetry}
                onPress={() => retry.run()}
                accessibilityHint={canRetry ? t('mobile.automations.run.retry_hint', 'Replays this run with the same trigger data') : hint}
            />
            {canRetry ? null : (
                <Text variant="label" tone="tertiary">
                    {hint}
                </Text>
            )}
        </>
    );
}
