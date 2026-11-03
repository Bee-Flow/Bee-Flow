/**
 * The one thing a run's state lets you do: decide the step it waits on, stop
 * it while it moves or waits, or run it again once it has settled.
 *
 * A paused run says what it waits on (@/shared/runs/runPhase `runPause`), with
 * a "Test" marker on a test or dry run, and every pause can be stopped: a run
 * waiting for approval is withdrawn, one waiting on a form page is closed.
 * A test run's Stop is "Discard this test run". The phone cannot answer a form
 * page, so that pause says where it can be answered. An older server refuses
 * to stop a form wait with a 409; the screen shows its sentence.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { RunPause } from '@/shared/runs/runPhase';
import { Badge, Button, Text } from '@/shared/ui';

import { VIEW_ONLY_RUN_HINT } from '../model/runAccess';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stack: { gap: theme.spacing.sm },
        line: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        text: { flexShrink: 1 },
        pair: { flexDirection: 'row', gap: theme.spacing.sm },
        half: { flex: 1 },
    });

interface Action<T = void> {
    run: (value: T) => void;
    pending: boolean;
}

interface DecideAction extends Action<'approve' | 'reject'> {
    /** Still finding out whether approving asks for answers: Approve waits. */
    checking?: boolean;
}

/** What the run waits on, with the Test marker and (for a form page) where to answer it. */
function PauseLine({ pause }: { pause: RunPause }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.stack} testID="run-pause">
            <View style={styles.line}>
                {pause.testLabel ? <Badge label={pause.testLabel} tone="ai" testID="run-test-marker" /> : null}
                <Text variant="body" weight="semibold" style={styles.text}>
                    {pause.text}
                </Text>
            </View>
            {pause.hint ? (
                <Text variant="caption" tone="tertiary">
                    {pause.hint}
                </Text>
            ) : null}
        </View>
    );
}

function DecideButtons({ decide }: { decide: DecideAction }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.pair}>
            <Button
                label={t('approvals.approve', 'Approve')}
                onPress={() => decide.run('approve')}
                loading={decide.pending}
                disabled={decide.checking}
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

function StopButton({ label, stop, variant = 'danger' }: { label: string; stop: Action; variant?: 'danger' | 'secondary' }) {
    return <Button label={label} variant={variant} fullWidth loading={stop.pending} onPress={() => stop.run()} testID="run-stop" />;
}

function PausedActions({ pause, decide, stop }: { pause: RunPause; decide: DecideAction; stop: Action }) {
    const styles = useThemedStyles(makeStyles);
    // A person who may decide sees Approve and Reject first, and Stop below
    // them as the quieter way out; anyone else has only Stop.
    const deciding = pause.kind === 'approval' && pause.canDecide !== false;
    return (
        <View style={styles.stack}>
            <PauseLine pause={pause} />
            {deciding ? <DecideButtons decide={decide} /> : null}
            <StopButton label={pause.stopLabel} stop={stop} variant={deciding ? 'secondary' : 'danger'} />
        </View>
    );
}

export function RunActions({
    pause,
    live,
    decide,
    stop,
    retry,
    canRetry = true,
}: {
    /** The pause the run is in (runPause), or null when it is not paused. */
    pause: RunPause | null;
    /** The run is still going (running or queued). */
    live: boolean;
    decide: DecideAction;
    stop: Action;
    retry: Action;
    /** false when the server says this person may not start a run (a view share). */
    canRetry?: boolean;
}) {
    const t = useTranslation();
    if (pause) return <PausedActions pause={pause} decide={decide} stop={stop} />;
    if (live) return <StopButton label={t('automations.run_progress_banner.stop_this_run', 'Stop this run')} stop={stop} />;
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
