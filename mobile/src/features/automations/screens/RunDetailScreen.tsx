/**
 * One run in full: how it ended, its facts, what you can do about it, and its
 * steps. Polls only while the run is unsettled; `getRunSteps` returns the whole
 * JOURNEY, so an automation that paused for an approval and continued in a child
 * run reads as one timeline — the only way the timings make sense.
 */

import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryScreen, type DetailQuery } from '@/shared/patterns';
import { runPause, runPhase } from '@/shared/runs/runPhase';
import { ScreenHeader, useToast } from '@/shared/ui';

import { RunActions } from '../components/RunActions';
import { RunFacts } from '../components/RunFacts';
import { RunOutcome } from '../components/RunOutcome';
import { RunStepsSection } from '../components/RunStepsSection';
import { useCancelRun, useRetryRun, useRunRefresh } from '../hooks/mutations';
import { useRun, useRunSteps } from '../hooks/queries';
import { useRunDecision } from '../hooks/useRunDecision';
import { useRunStream } from '../hooks/useRunStream';
import { mayStartRun } from '../model/runAccess';
import { isLiveStatus, isMovingRun, statusLabel, statusToken } from '../model/status';
import { absoluteTime, runElapsedMs } from '../model/time';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg },
        top: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.lg },
    });

/** The run's writes, each toasting its outcome the way this screen always has. */
function useRunDetailActions(automationId: string, runId: string, run: AutomationRun | null | undefined) {
    const router = useRouter();
    const { toast } = useToast();
    const t = useTranslation();
    const refresh = useRunRefresh(automationId, runId);
    const onError = (error: Error) => toast(describeError(error).message, 'error');

    const retry = useRetryRun(automationId, runId, {
        onSuccess: (result) => {
            if (result?.run?.id) {
                // The retry is a NEW run linked to this one; showing the old
                // row afterwards would be showing the wrong thing.
                router.replace(`/automations/${automationId}/runs?runId=${result.run.id}`);
                return;
            }
            toast(t('mobile.automations.retry_started', 'Retry started — it is still running'));
        },
        onError,
    });
    // A pause stops at once (the approval is withdrawn, the form wait closed);
    // a run that is doing work stops after its current step.
    const paused = !!run && !isMovingRun(run) && isLiveStatus(run.status);
    const cancel = useCancelRun(refresh, {
        onSuccess: () => toast(stopWords(paused, runPhase(run).isTest, t), paused ? 'success' : 'neutral'),
        onError,
    });
    const decide = useRunDecision(run, refresh);
    return { retry, cancel, decide };
}

function stopWords(paused: boolean, isTest: boolean, t: TranslateFn): string {
    if (!paused) return t('mobile.automations.stop_requested', 'Stop requested — it ends after the current step');
    return isTest ? t('mobile.runs.stopped_test', 'Test run discarded') : t('mobile.runs.stopped', 'Run stopped');
}

/**
 * Back from a run goes where the person came from — the run list, a Cowork
 * card, the runs log, a form's answers — like the hardware Back does.
 * Replacing the screen with the list stacked a second list over the one the
 * run was opened from, and sent anyone who came from elsewhere to a list they
 * never visited. Only a run opened cold (a deep link, a notification) has
 * nothing behind it, and lands on its automation's list.
 */
export function leaveRun(router: Pick<ReturnType<typeof useRouter>, 'back' | 'canGoBack' | 'replace'>, automationId: string): void {
    if (router.canGoBack()) router.back();
    else router.replace(`/automations/${automationId}/runs`);
}

export function RunDetailScreen({ automationId, runId }: { automationId: string; runId: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();

    const run = useRun(runId);
    const live = isLiveStatus(run.data?.status);
    const steps = useRunSteps(runId, live);
    useRunStream({
        automationId,
        enabled: live,
        onEvent: () => {
            void run.refetch();
            void steps.refetch();
        },
    });
    const { retry, cancel, decide } = useRunDetailActions(automationId, runId, run.data);
    const elapsed = useMemo(() => (run.data ? runElapsedMs(run.data) : null), [run.data]);

    const query: DetailQuery<AutomationRun> = {
        data: run.data ?? undefined,
        isLoading: run.isLoading,
        isError: run.isError,
        error: run.error ?? new Error(t('mobile.automations.run_not_loaded', 'This run could not be loaded.')),
        refetch: run.refetch,
    };

    return (
        <QueryScreen
            query={query}
            header={(current) =>
                current ? (
                    <ScreenHeader
                        title={statusLabel(t, statusToken(current.status))}
                        subtitle={current.startedAt ? absoluteTime(current.startedAt) : undefined}
                        onBack={() => leaveRun(router, automationId)}
                    />
                ) : (
                    <ScreenHeader title={t('runs.tab.detail_label', 'Run')} />
                )
            }
            refresh={() => Promise.all([run.refetch(), steps.refetch()])}
            contentContainerStyle={styles.content}
        >
            {(current) => (
                <>
                    <View style={styles.top}>
                        <RunOutcome run={current} failed={statusToken(current.status).tone === 'error'} />
                        <RunFacts run={current} elapsed={elapsed} />
                        <RunActions
                            pause={runPause(current, t)}
                            live={isLiveStatus(current.status) && isMovingRun(current)}
                            decide={{ run: decide.decide, pending: decide.pending, checking: decide.checking }}
                            stop={{ run: () => cancel.mutate(runId), pending: cancel.isPending }}
                            retry={{ run: () => retry.mutate(), pending: retry.isPending }}
                            canRetry={mayStartRun(current)}
                        />
                    </View>
                    <RunStepsSection steps={steps} />
                </>
            )}
        </QueryScreen>
    );
}
