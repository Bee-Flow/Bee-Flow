/**
 * The editor's runs — the toolbar's dry run and its menu's "Run live" and
 * "Start from" (the web's RunFlowMenu), a card's "Test this step",
 * "Run up to here" and "Run from here", the step editor's Test — over the
 * automation's shared test-run store (testRunStore.ts), and what the flow shows
 * of them: the rows by step id (runStatus.ts, for the card badges, the
 * borders and the line colours), and where the run is (runFocus.ts, for the
 * line over the flow).
 *
 * The request only answers when the run is over, so while it is out the
 * run feed (useRunStream, GET /_runs/stream) is open and its step events
 * light the cards up as they go — the web's live progress, pushed instead of
 * polled. A run the feed reported can be stopped. Every run enters with its
 * trigger's saved sample (runMenu.ts `runInputFor`, the web's runBody).
 */

import { useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import {
    statusLabel, statusToken, useCancelRun, useRunListsRefresh, useRunStream, type RunEvent,
 RunTriggerResult } from '@/features/automations';
import type { StepRunMode, StepRunResult, TestRunResult } from '@/features/flow-editor/api';
import { useDraftState, useDryRun, useLiveRun, useStepRun } from '@/features/flow-editor/hooks';
import type { FlowDefinition } from '@/features/flow-editor/model';
import type { DraftStore } from '@/features/flow-editor/state';
import { useToast } from '@/shared/ui';

import { computeRunFocus, type RunFocus } from './runFocus';
import { currentStart, runInputFor, startPoints, type StartPoint } from './runMenu';
import { applyRunEvent, beginRun, failRun, IDLE_TEST_RUN, settleDryRun, settleStepRun, type TestRunState } from './runState';
import { effectiveRunByStep, type RunRowLike } from './runStatus';
import { testRunStoreFor, updateTestRun } from './testRunStore';

export interface TestRuns {
    state: TestRunState;
    /** What each card shows: the effective row of every step, pins included. */
    runByStep: ReadonlyMap<string, RunRowLike>;
    focus: RunFocus | null;
    running: boolean;
    dryRun: () => void;
    /** Every step for real; the caller asks first. */
    runLive: () => void;
    /** The entry points "Start from" offers (none for a single-trigger automation), and the chosen one. */
    starts: StartPoint[];
    from: string | null;
    setFrom: (id: string | null) => void;
    testStep: (stepId: string, mode: StepRunMode) => void;
    /** Cancel the run the feed reported (only once it has). */
    stop: (() => void) | null;
    /** Forget the last run: the cards go back to how they were. */
    clear: () => void;
}

function finishedWords(status: string, t: TranslateFn): { text: string; error: boolean } {
    const token = statusToken(status);
    return { text: t('mobile.flow.run.finished', 'Test run: {status}', { status: statusLabel(t, token) }), error: token.tone === 'error' };
}

/** Subscribe to the automation's test run, and keep the run feed open while one is out. */
function useRunFeed(flowKey: string, store: DraftStore): TestRunState {
    const state = useStore(testRunStoreFor(flowKey));
    const automationId = useDraftState(store, (s) => s.automationId);
    useRunStream({
        automationId: automationId ?? undefined,
        enabled: state.pending && !!automationId,
        onEvent: (event: RunEvent) => updateTestRun(flowKey, (s) => applyRunEvent(s, event)),
    });
    return state;
}

/** How a finished run is told, and how a failed one is recorded. */
function useRunReports(flowKey: string) {
    const t = useTranslation();
    const { toast } = useToast();
    const report = (status: string | null | undefined) => {
        if (!status) return;
        const words = finishedWords(status, t);
        toast(words.text, words.error ? 'error' : 'success');
    };
    const onError = (err: unknown) => {
        const message = describeError(err).message;
        updateTestRun(flowKey, (s) => failRun(s, message, Date.now()));
        toast(message, 'error');
    };
    /** A live run's three answers: finished (like a dry run), still going, or nothing to run against. */
    const onLive = (result: RunTriggerResult | null) => {
        if (result?.run && !result.pending && !result.skipped) {
            updateTestRun(flowKey, (s) => settleDryRun(s, { run: result.run ?? null, steps: result.steps ?? [] }, Date.now()));
            report(result.run.status);
            return;
        }
        updateTestRun(flowKey, () => IDLE_TEST_RUN);
        toast(
            result?.skipped
                ? result.message || t('mobile.flow.run.nothing', 'Nothing to run against yet.')
                : t('mobile.flow.run.started', 'Run started — results will appear in Run history shortly.'),
            'success',
        );
    };
    const onCancelError = (err: unknown) => toast(describeError(err).message, 'error');
    return { report, onError, onLive, onCancelError };
}

function startFrom(definition: FlowDefinition | null, from: string | null) {
    return { starts: startPoints(definition), from: currentStart(definition, from) };
}

export function useTestRuns(flowKey: string, store: DraftStore): TestRuns {
    const state = useRunFeed(flowKey, store);
    const definition = useDraftState(store, (s) => s.definition);
    const [from, setFrom] = useState<string | null>(null);
    const { report, onError, onLive, onCancelError } = useRunReports(flowKey);
    const dry = useDryRun(flowKey, {
        onSuccess: (result: TestRunResult) => {
            updateTestRun(flowKey, (s) => settleDryRun(s, result, Date.now()));
            report(result.run?.status);
        },
        onError,
    });
    const step = useStepRun(flowKey, {
        onSuccess: (result: StepRunResult) => {
            updateTestRun(flowKey, (s) => settleStepRun(s, result, Date.now()));
            report(result.stepRecord?.status ?? result.run?.status);
        },
        onError,
    });
    const live = useLiveRun(flowKey, { onSuccess: onLive, onError });
    const cancel = useCancelRun(useRunListsRefresh(), { onError: onCancelError });
    const running = state.pending || dry.isPending || step.isPending || live.isPending;
    const liveRunId = state.pending ? state.runId : null;
    // Every card and canvas node looks its run up here: one Map per change, not per render.
    const runByStep = useMemo(() => effectiveRunByStep(definition, state.rows), [definition, state.rows]);

    return {
        state,
        runByStep,
        focus: computeRunFocus({ runSteps: state.rows, runInFlight: running, definition }),
        running,
        ...startFrom(definition, from),
        setFrom,
        dryRun: () => {
            if (running) return;
            updateTestRun(flowKey, (s) => beginRun(s, { kind: 'dry', now: Date.now() }));
            dry.mutate(runInputFor(definition, from));
        },
        runLive: () => {
            if (running) return;
            updateTestRun(flowKey, (s) => beginRun(s, { kind: 'dry', now: Date.now() }));
            live.mutate(runInputFor(definition, from));
        },
        testStep: (stepId, mode) => {
            if (running) return;
            updateTestRun(flowKey, (s) => beginRun(s, { kind: 'step', stepId, mode, now: Date.now() }));
            step.mutate({ stepId, mode, ...runInputFor(definition) });
        },
        stop: liveRunId && !cancel.isPending ? () => cancel.mutate(liveRunId) : null,
        clear: () => updateTestRun(flowKey, () => IDLE_TEST_RUN),
    };
}
