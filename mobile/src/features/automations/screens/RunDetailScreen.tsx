/**
 * One run in full: how it ended, its facts, what you can do about it, and its
 * steps. Polls only while the run is unsettled; `getRunSteps` returns the whole
 * JOURNEY, so a routine that paused for an approval and continued in a child
 * run reads as one timeline — the only way the timings make sense.
 */

import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryScreen, type DetailQuery } from '@/shared/patterns';
import { ScreenHeader, useToast } from '@/shared/ui';

import { RunActions } from '../components/RunActions';
import { RunFacts } from '../components/RunFacts';
import { RunOutcome } from '../components/RunOutcome';
import { RunStepsSection } from '../components/RunStepsSection';
import { useCancelRun, useDecideRunStep, useRetryRun, useRunRefresh } from '../hooks/mutations';
import { useRun, useRunSteps } from '../hooks/queries';
import { useRunStream } from '../hooks/useRunStream';
import { isLiveStatus, statusLabel, statusToken } from '../model/status';
import { absoluteTime, runElapsedMs } from '../model/time';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg },
        top: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.lg },
    });

/** The run's writes, each toasting its outcome the way this screen always has. */
function useRunDetailActions(automationId: string, runId: string) {
    const router = useRouter();
    const { toast } = useToast();
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
            toast('Retry started — it is still running');
        },
        onError,
    });
    const cancel = useCancelRun(refresh, {
        onSuccess: () => toast('Stop requested — it ends after the current step'),
        onError,
    });
    const decide = useDecideRunStep(runId, refresh, {
        onSuccess: () => toast('Decision sent', 'success'),
        onError,
    });
    return { retry, cancel, decide };
}

/**
 * Back from a run goes where the person came from — the run list, a Cowork
 * card, the runs log, a form's answers — like the hardware Back does.
 * Replacing the screen with the list stacked a second list over the one the
 * run was opened from, and sent anyone who came from elsewhere to a list they
 * never visited. Only a run opened cold (a deep link, a notification) has
 * nothing behind it, and lands on its routine's list.
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
    const { retry, cancel, decide } = useRunDetailActions(automationId, runId);
    const elapsed = useMemo(() => (run.data ? runElapsedMs(run.data) : null), [run.data]);

    const query: DetailQuery<AutomationRun> = {
        data: run.data ?? undefined,
        isLoading: run.isLoading,
        isError: run.isError,
        error: run.error ?? new Error('This run could not be loaded.'),
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
                    <ScreenHeader title="Run" />
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
                            awaitingApproval={current.status === 'awaiting_approval'}
                            live={isLiveStatus(current.status)}
                            decide={{ run: (d) => decide.mutate(d), pending: decide.isPending }}
                            stop={{ run: () => cancel.mutate(runId), pending: cancel.isPending }}
                            retry={{ run: () => retry.mutate(), pending: retry.isPending }}
                        />
                    </View>
                    <RunStepsSection steps={steps} />
                </>
            )}
        </QueryScreen>
    );
}
