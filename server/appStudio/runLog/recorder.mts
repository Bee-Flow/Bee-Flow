/**
 * The run log of a SERVER walk (app_run_action, app_run_tests, a background job, the mailbox
 * hook): one run row, one step row per step the walk reached, with its duration, status, the
 * cleaned error and, per AI step, the model, tokens and estimated cost.
 *
 *   startRun(meta, deps)        a recorder; with `existingId` the row already exists (a
 *                               background job's row, a live MCP run's lock row) and is not
 *                               inserted or finished here
 *   withRunLog(host, recorder)  the walker host with the recording around it: `execute` runs in
 *                               a runTrace frame (the AI calls of that step), `onStepEnd` is
 *                               forwarded to the inner host AND recorded
 *
 * Steps are buffered and written in batches (20 steps or 2 s). The log never breaks a run: the
 * first database error is logged once (message only) and the recorder goes quiet. With
 * STUDIO_APP_RUN_LOG=off it records nothing. No result, scope, prompt or variable is kept.
 */

import { createRequire } from 'node:module';
import { captureStep } from './runTrace.mts';
import type { AiSummary } from './runTrace.mts';
import type { StepEndEvent, WalkHost } from '../sequenceWalkTypes.mts';
import { maxStepsPerRun, newRunId, runLogEnabled, runLogError } from '../../stores/studioAppData/runPolicy.mts';
import type { NewLoggedRun, RunLogStore, StepRecord } from '../../stores/studioAppData/runLogStore.mts';

const nodeRequire = createRequire(import.meta.url);

export type RunMeta = Omit<NewLoggedRun, 'id'> & { existingId?: string | null };

export type RunEnd = {
    status: 'success' | 'error' | 'cancelled' | 'interrupted' | 'refused';
    error?: string | null; errorCode?: string | null; durationMs: number; truncated?: boolean; endedBy?: string | null;
};

export interface RunRecorder {
    /** The run row's id, or null when nothing is recorded. */
    readonly id: string | null;
    step(e: StepEndEvent & { ai?: AiSummary | null }): void;
    flush(): Promise<void>;
    finish(o: RunEnd): Promise<void>;
}

export type RecorderDeps = {
    store?: () => RunLogStore;
    log?: { warn: (...a: unknown[]) => void };
    now?: () => number;
    enabled?: boolean;
    maxSteps?: number;
    batchSize?: number;
    flushMs?: number;
};

export const NOOP_RECORDER: RunRecorder = Object.freeze({
    id: null, step: () => {}, flush: async () => {}, finish: async () => {},
});

function defaultStore(): RunLogStore {
    return (nodeRequire('../../stores/studioAppData/runLogStore.mts') as { runLogStore: () => RunLogStore }).runLogStore();
}

/** A walker step end as a stored step: the reason of a skip or refusal is kept like an error, cleaned. */
export function toStepRecord(e: StepEndEvent & { ai?: AiSummary | null }, now: number): StepRecord {
    const ms = Math.max(0, Math.floor(e.ms || 0));
    return {
        actionId: e.ownerActionId || null, stepIndex: e.ordinal, path: e.path, iteration: e.iteration, kind: e.kind,
        status: e.status, error: runLogError(e.error), errorCode: typeof e.code === 'string' ? e.code : null,
        attempts: typeof e.attempts === 'number' && e.attempts > 1 ? e.attempts : null, handled: e.handled === true,
        mocked: e.mocked === true, startedAt: now - ms, durationMs: ms, ai: e.ai ?? null,
    };
}

/** Start the run log of one walk. Never throws: a failing insert gives the NOOP recorder. */
export async function startRun(meta: RunMeta, deps: RecorderDeps = {}): Promise<RunRecorder> {
    if (deps.enabled === false || (deps.enabled === undefined && !runLogEnabled())) return NOOP_RECORDER;
    const log = deps.log ?? (nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void });
    const now = deps.now ?? (() => Date.now());
    let store: RunLogStore;
    try { store = (deps.store ?? defaultStore)(); } catch (e) {
        log.warn('[StudioRunLog] the run log is unavailable:', (e as Error)?.message);
        return NOOP_RECORDER;
    }
    const owns = !meta.existingId;
    const id = meta.existingId || newRunId();
    if (owns) {
        try {
            const { existingId: _skip, ...row } = meta;
            if (!(await store.insertRun({ ...row, id }))) return NOOP_RECORDER;
        } catch (e) {
            log.warn('[StudioRunLog] could not start a run:', (e as Error)?.message);
            return NOOP_RECORDER;
        }
    }
    return makeRecorder(id, owns, store, { log, now, maxSteps: deps.maxSteps ?? maxStepsPerRun(), batchSize: deps.batchSize ?? 20, flushMs: deps.flushMs ?? 2000 });
}

function makeRecorder(id: string, owns: boolean, store: RunLogStore, o: { log: { warn: (...a: unknown[]) => void }; now: () => number; maxSteps: number; batchSize: number; flushMs: number }): RunRecorder {
    let dead = false;
    let finished = false;
    let buffer: StepRecord[] = [];
    let chain: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const quiet = (what: string, e: unknown): void => {
        if (dead) return;
        dead = true;
        o.log.warn(`[StudioRunLog] ${what} (run ${id}); this run is not logged further:`, (e as Error)?.message);
    };
    const flush = (): Promise<void> => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (dead || !buffer.length) return chain;
        const batch = buffer;
        buffer = [];
        chain = chain.then(() => store.appendSteps(id, batch, { maxSteps: o.maxSteps })).catch((e) => quiet('could not write steps', e));
        return chain;
    };
    return {
        id,
        step(e) {
            if (dead || finished) return;
            buffer.push(toStepRecord(e, o.now()));
            if (buffer.length >= o.batchSize) { void flush(); return; }
            if (!timer) {
                timer = setTimeout(() => { timer = null; void flush(); }, o.flushMs);
                timer.unref?.();
            }
        },
        flush,
        async finish(end) {
            if (finished) return;
            finished = true;
            await flush();
            if (!owns || dead) return;
            try {
                await store.finishLogged(id, {
                    status: end.status, error: runLogError(end.error), errorCode: end.errorCode ?? null,
                    durationMs: end.durationMs, endedBy: end.endedBy ?? null, truncated: end.truncated,
                });
            } catch (e) { quiet('could not finish', e); }
        },
    };
}

/**
 * The host with the run log around it. The walk is sequential, so the AI calls of a step are
 * kept by path until its onStepEnd (a retried step's attempts add up; a loop body reuses its path
 * one iteration after the other).
 */
export function withRunLog(host: WalkHost, recorder: RunRecorder): WalkHost {
    if (recorder === NOOP_RECORDER || !recorder.id) return host;
    const aiByPath = new Map<string, AiSummary>();
    const add = (path: string, ai: AiSummary | null): void => {
        if (!ai) return;
        const prev = aiByPath.get(path);
        if (!prev) { aiByPath.set(path, ai); return; }
        const sameCurrency = prev.currency === ai.currency || !prev.currency || !ai.currency;
        aiByPath.set(path, {
            calls: prev.calls + ai.calls, promptTokens: prev.promptTokens + ai.promptTokens,
            completionTokens: prev.completionTokens + ai.completionTokens, model: ai.model ?? prev.model, tier: ai.tier ?? prev.tier,
            cost: prev.cost === null ? ai.cost : (ai.cost === null || !sameCurrency ? prev.cost : prev.cost + ai.cost),
            currency: prev.currency ?? ai.currency,
        });
    };
    return {
        ...host,
        async execute(step, f, w) {
            const { value, ai } = await captureStep(() => host.execute(step, f, w));
            add(f.path, ai);
            return value;
        },
        async onStepEnd(e) {
            const ai = aiByPath.get(e.path) ?? null;
            aiByPath.delete(e.path);
            try { recorder.step({ ...e, ai }); } catch { /* the log never breaks a run */ }
            await host.onStepEnd?.(e);
        },
    };
}
