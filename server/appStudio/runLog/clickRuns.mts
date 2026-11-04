/**
 * The run log of a BROWSER run: the browser walks the sequence and sends each server step to
 * …/step on its own. The steps of one click are tied together by a run key the browser makes
 * (`runKey`, CLIENT_RUN_KEY_RE) and sends with every step; …/runs/end closes the run with the
 * browser's verdict. A run that never reports its end is closed by the idle rule
 * (runLogStore.closeIdleRuns). A step without a key (an older client, the mobile app) is logged
 * as a run of one step (tracked false).
 *
 *   beginClickStep(meta)              before the step runs; never rejects
 *   endClickStep(begun, step)         after it ran; best effort, the caller does not wait
 *   endClickRun(meta, outcome)        the browser's end report
 *   browserStepPath(action, …)        the walker path of a browser step (stepPaths, identity)
 *
 * Only the step's kind, position, status, duration, cleaned error and AI usage are stored.
 */

import { createRequire } from 'node:module';
import { stepPaths } from '../sequencePaths.mts';
import type { Obj } from '../sequenceWalkTypes.mts';
import type { AiSummary } from './runTrace.mts';
import { CLIENT_RUN_KEY_RE, maxStepsPerRun, newRunId, runLogEnabled, runLogError, visitorKey } from '../../stores/studioAppData/runPolicy.mts';
import type { RunLogStore } from '../../stores/studioAppData/runLogStore.mts';

const nodeRequire = createRequire(import.meta.url);

export type ClickMeta = {
    app: { id: string; userId: string }; actionId: string; origin: 'click' | 'public'; draft: boolean;
    definitionVersion: number | null; actorUserId: string | null; visitorKey: string | null; runKey?: unknown; client?: string | null;
};

export type Begun = { meta: ClickMeta; runId: string | null; untracked: boolean; disabled: boolean };

export type ClickStep = {
    kind: string; stepIndex: number | null; path: string; ownerActionId: string; iteration: number | null;
    startedAt: number; durationMs: number; result: { ok?: boolean; error?: unknown; code?: unknown } | null | undefined;
    ai: AiSummary | null;
};

export type ClickDeps = { store?: () => RunLogStore; log?: { warn: (...a: unknown[]) => void }; enabled?: boolean; maxSteps?: number };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The routes call these without deps. They record only once the server's boot
 * (boot/startupJobs.js) has called configureClickRuns(): a route test that loads the real router
 * with stubbed stores never reaches a database through here. A test of the log passes its own.
 */
let configured: ClickDeps | null = null;
export function configureClickRuns(deps: ClickDeps | null = {}): void {
    configured = deps;
}
const active = (deps: ClickDeps | undefined): ClickDeps | null => deps ?? configured;
const off = (d: ClickDeps | null): boolean => !d || d.enabled === false || (d.enabled === undefined && !runLogEnabled());

function storeOf(deps: ClickDeps): RunLogStore {
    return (deps.store ?? (() => (nodeRequire('../../stores/studioAppData/runLogStore.mts') as { runLogStore: () => RunLogStore }).runLogStore()))();
}
function logOf(deps: ClickDeps): { warn: (...a: unknown[]) => void } {
    return deps.log ?? (nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void });
}

const validKey = (v: unknown): string | null => (typeof v === 'string' && CLIENT_RUN_KEY_RE.test(v) ? v : null);

const rowOf = (meta: ClickMeta, id: string) => ({
    id, appId: meta.app.id, ownerUserId: meta.app.userId, actionId: meta.actionId, origin: meta.origin,
    viewerUserId: meta.actorUserId, visitorKey: meta.visitorKey, draft: meta.draft, definitionVersion: meta.definitionVersion,
    client: meta.client ?? 'web',
});

/** Claim (or reopen) the run of this key; without a key the step becomes a run of its own at the end. */
export async function beginClickStep(meta: ClickMeta, given?: ClickDeps): Promise<Begun> {
    const deps = active(given);
    if (!deps || off(deps)) return { meta, runId: null, untracked: false, disabled: true };
    const key = validKey(meta.runKey);
    if (!key) return { meta, runId: null, untracked: true, disabled: false };
    try {
        const runId = await storeOf(deps).claimClickRun({ ...rowOf(meta, newRunId()), clientRunKey: key });
        return { meta, runId, untracked: !runId, disabled: false };
    } catch (e) {
        logOf(deps).warn('[StudioRunLog] could not open a browser run:', (e as Error)?.message);
        return { meta, runId: null, untracked: false, disabled: true };
    }
}

/** Record the step. Never rejects (a failure is logged once per step, message only). */
const pending = new Set<Promise<void>>();

/** Test seam: resolves when every step record started so far has been written (or failed). */
export async function _settledClickSteps(): Promise<void> {
    while (pending.size) await Promise.all([...pending]);
}

export function endClickStep(begunP: Promise<Begun>, step: ClickStep, given?: ClickDeps): Promise<void> {
    const p = recordClickStep(begunP, step, given).finally(() => { pending.delete(p); });
    pending.add(p);
    return p;
}

async function recordClickStep(begunP: Promise<Begun>, step: ClickStep, given?: ClickDeps): Promise<void> {
    const deps = active(given) ?? {};
    try {
        const begun = await begunP;
        if (begun.disabled) return;
        const store = storeOf(deps);
        const ok = !!step.result && step.result.ok === true;
        const record = {
            actionId: step.ownerActionId, stepIndex: step.stepIndex, path: step.path, iteration: step.iteration, kind: step.kind,
            status: ok ? 'ok' : 'error', error: ok ? null : runLogError(step.result?.error ?? 'Step failed'),
            errorCode: !ok && typeof step.result?.code === 'string' ? step.result.code : null, attempts: null, handled: false,
            mocked: false, startedAt: step.startedAt, durationMs: step.durationMs, ai: step.ai,
        };
        const maxSteps = deps.maxSteps ?? maxStepsPerRun();
        if (begun.runId) {
            await store.appendSteps(begun.runId, [record], { maxSteps });
            return;
        }
        // No key (or someone else's): a run of this one step.
        const id = newRunId();
        if (!(await store.insertRun({ ...rowOf(begun.meta, id), tracked: false }))) return;
        await store.appendSteps(id, [record], { maxSteps });
        await store.finishLogged(id, {
            status: ok ? 'success' : 'error', error: record.error, errorCode: record.errorCode, durationMs: step.durationMs, endedBy: 'step',
        });
    } catch (e) {
        logOf(deps).warn('[StudioRunLog] could not record a browser step:', (e as Error)?.message);
    }
}

export type RunEndOutcome = { status?: 'success' | 'error' | 'cancelled'; error?: string | null; handled?: boolean };

/** The browser's end report for its key. False when there is nothing (of this actor) to end. */
export async function endClickRun(meta: Omit<ClickMeta, 'draft' | 'definitionVersion'>, outcome: RunEndOutcome, given?: ClickDeps): Promise<boolean> {
    const key = validKey(meta.runKey);
    const deps = active(given);
    if (!key || !deps || off(deps)) return false;
    try {
        return await storeOf(deps).endClickRun(meta.app.id, key, { viewerUserId: meta.actorUserId, visitorKey: meta.visitorKey }, {
            status: outcome.status ?? 'success', error: runLogError(outcome.error), handled: outcome.handled === true,
        });
    } catch (e) {
        logOf(deps).warn('[StudioRunLog] could not end a browser run:', (e as Error)?.message);
        return false;
    }
}

/**
 * The walker path of the step a browser sent: the root action's stepPaths (called actions
 * included), followed hop by hop along `callPath` (each hop a call_action ordinal of the action
 * it sits in), then the step's ordinal within the last action. `#<index>` when it cannot be
 * placed (it still runs; only the label is coarser).
 */
export function browserStepPath(def: unknown, rootId: string, stepIndex: number, callPath: unknown): string {
    try {
        const actions = isObject(def) && isObject(def.actions) ? def.actions : {};
        const root = Object.hasOwn(actions, rootId) ? actions[rootId] : null;
        if (!isObject(root)) return `#${stepIndex}`;
        const resolveCallee = (id: string): Obj | null => (Object.hasOwn(actions, id) && isObject(actions[id]) ? actions[id] as Obj : null);
        const all = stepPaths(root, { resolveCallee, rootId });
        const hops = Array.isArray(callPath) ? callPath.filter((n): n is number => Number.isInteger(n)) : [];
        let prefix = '';
        let owner: string | undefined;
        const inScope = (p: { path: string; ownerActionId?: string }): boolean => p.path.startsWith(prefix)
            && !p.path.slice(prefix.length).includes('.call.') && p.ownerActionId === owner;
        for (const hop of hops) {
            const call = all.find((p) => inScope(p) && p.ordinal === hop && p.kind === 'call_action');
            if (!call) return `#${stepIndex}`;
            prefix = `${call.path}.call.`;
            owner = all.find((p) => p.path.startsWith(prefix))?.ownerActionId;
            if (!owner) return `#${stepIndex}`;
        }
        return all.find((p) => inScope(p) && p.ordinal === stepIndex)?.path ?? `#${stepIndex}`;
    } catch {
        return `#${stepIndex}`;
    }
}

export type LoggedStep = ClickMeta & {
    def: unknown; kind: string; stepIndex: number; callPath?: unknown; ownerActionId: string; iteration?: number | null;
};

/**
 * One browser step with its run log around it: begin (claim the run of its key), run `exec` in a
 * runTrace frame (its AI calls), record the step without waiting. The step's answer is `exec`'s,
 * unchanged; the log never fails it.
 */
export async function loggedClickStep<T>(s: LoggedStep, exec: () => Promise<T>): Promise<T> {
    const { captureStep } = nodeRequire('./runTrace.mts') as typeof import('./runTrace.mts');
    const begun = beginClickStep(s);
    const t0 = Date.now();
    let value: T;
    let ai: AiSummary | null = null;
    try {
        ({ value, ai } = await captureStep(exec));
    } catch (e) {
        void endClickStep(begun, stepOf(s, t0, { ok: false, error: 'The step could not run' }, null));
        throw e;
    }
    void endClickStep(begun, stepOf(s, t0, value as ClickStep['result'], ai));
    return value;
}

function stepOf(s: LoggedStep, t0: number, result: ClickStep['result'], ai: AiSummary | null): ClickStep {
    return {
        kind: s.kind, stepIndex: s.stepIndex, ownerActionId: s.ownerActionId, path: browserStepPath(s.def, s.actionId, s.stepIndex, s.callPath),
        iteration: Number.isInteger(s.iteration) ? Number(s.iteration) : null, startedAt: t0, durationMs: Date.now() - t0, result, ai,
    };
}

/** A bare run_automation action: a run of one step, finished from the automation's outcome. */
export function logAutomationRun(meta: ClickMeta, settled: Promise<{ status?: string; error?: string } | null>, t0: number): void {
    const begun = beginClickStep({ ...meta, runKey: null });
    void settled.then((run) => endClickStep(begun, {
        kind: 'run_automation', stepIndex: 0, ownerActionId: meta.actionId, path: 'action[0]', iteration: null, startedAt: t0,
        durationMs: Date.now() - t0, ai: null,
        result: run && run.status === 'success' ? { ok: true } : { ok: false, error: run?.error || (run ? `The automation ended ${run.status}` : 'The automation could not run') },
    }));
}

type AppRef = { id: string; userId: string; definitionVersion?: number | null; publishedVersion?: number | null };
type StepRef = { kind?: unknown };
type StepBody = { stepIndex?: unknown; callPath?: unknown; index?: unknown; runKey?: unknown } | null | undefined;

/** Who ran what, for a signed-in click: the draft's version for the owner's draft run, else the live one. */
export function signedInClick(app: AppRef, actionId: string, userId: string, draft: boolean, runKey: unknown): ClickMeta {
    return {
        app, actionId, origin: 'click', draft, definitionVersion: (draft ? app.definitionVersion : app.publishedVersion) ?? null,
        actorUserId: userId, visitorKey: null, runKey, client: 'web',
    };
}

function stepPart(def: unknown, step: StepRef, body: StepBody, ownerActionId: string) {
    return {
        def, kind: String(step.kind), stepIndex: Number(body?.stepIndex), callPath: body?.callPath, ownerActionId,
        iteration: Number.isInteger(body?.index) ? Number(body?.index) : null,
    };
}

/** A signed-in /step (or /step/stream) with its run log; the body's runKey ties it to its click. */
export function loggedSignedInStep<T>(s: { app: AppRef; actionId: string; userId: string; draft: boolean; def: unknown; step: StepRef; body: StepBody; ownerActionId: string }, exec: () => Promise<T>): Promise<T> {
    return loggedClickStep({ ...signedInClick(s.app, s.actionId, s.userId, s.draft, s.body?.runKey), ...stepPart(s.def, s.step, s.body, s.ownerActionId) }, exec);
}

/** A public page's /step with its run log: no person, the visitor as a hash of the anonymous viewer id (never the page token). */
export function loggedPublicStep<T>(s: { app: AppRef; actionId: string; viewerId: unknown; def: unknown; step: StepRef; body: StepBody; ownerActionId: string }, exec: () => Promise<T>): Promise<T> {
    const meta: ClickMeta = {
        app: s.app, actionId: s.actionId, origin: 'public', draft: false, definitionVersion: s.app.publishedVersion ?? null,
        actorUserId: null, visitorKey: visitorKey(s.viewerId), runKey: s.body?.runKey, client: 'public',
    };
    return loggedClickStep({ ...meta, ...stepPart(s.def, s.step, s.body, s.ownerActionId) }, exec);
}
