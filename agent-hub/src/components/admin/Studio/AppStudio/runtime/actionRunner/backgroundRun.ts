/**
 * A background action (a sequence with `background: true`): the browser asks its leading
 * confirms, starts the server job (POST …/actions/:actionId/background) and follows it by
 * polling (GET …/actions/jobs/:jobId). runAction resolves as soon as the job is accepted;
 * the action's entry stays `running` (with the job's progress) until the job ends. Leaving
 * the page stops only the polling, never the job: the next mount picks it up again
 * (resumeActiveJobs).
 *
 * At the end the job's written variables are set, its deferred toasts and refreshes are
 * replayed, and the entry carries the result (or the error, with a toast).
 *
 * A sequence with `runOn: 'server'` (schema 3) starts the same job, but runAction waits for it
 * (runServerAction): what the click does next happens when the run has ended.
 *
 * A job can be on hold (status `paused`: a step waits). The entry stays `running` with what it
 * waits for; the poll slows down, and a click that was waiting for the job stops waiting: the
 * run goes on by itself. A cancelled job leaves the entry idle.
 */
import { actionsUrl, getAuthed, jobsUrl, postJson } from '@/api/actionHttp';
import type { JobEffect, JobView } from '@/api/actionHttp';
import { defaultConfirm, readJson, showToast, sleep } from './core';
import type { RunOpts, RunnableAction, RunStep } from './core';
import type { RunnerContext } from './runnerContext';

const POLL_FIRST_MS = 1500;
const POLL_LATER_MS = 5000;
const POLL_SLOW_AFTER_MS = 30_000;
/** A job on hold changes when its wait ends: looked at less often. */
const POLL_ON_HOLD_MS = 15_000;
/** The first looks at a job the click is waiting for: most server runs end within a second. */
const POLL_AWAITED_MS = [250, 500, 1000];
const MAX_NETWORK_FAILURES = 5;

/** Test seam: the poll's wait (fake timers in tests). */
export const backgroundTiming = { wait: (ms: number): Promise<void> => sleep(ms), now: (): number => Date.now() };

function leadingConfirms(action: RunnableAction): RunStep[] {
    const steps = Array.isArray(action.steps) ? action.steps as RunStep[] : [];
    const out: RunStep[] = [];
    for (const step of steps) {
        if (!step || step.kind !== 'confirm') break;
        out.push(step);
    }
    return out;
}

async function askConfirms(ctx: RunnerContext, action: RunnableAction): Promise<boolean> {
    const ask = ctx.live.current.confirm || ((st: RunStep) => defaultConfirm(st, ctx.tr));
    for (const step of leadingConfirms(action)) {
        if (!(await ask(step))) return false;
    }
    return true;
}

function startBody(ctx: RunnerContext, opts: RunOpts): Record<string, unknown> {
    const body: Record<string, unknown> = { formValues: opts.formValues || {}, vars: ctx.live.current.vars || {} };
    if (opts.item !== undefined) body.item = opts.item;
    if (opts.index !== undefined) body.index = opts.index;
    if (opts.value !== undefined) body.value = opts.value;
    return body;
}

async function replayEffect(ctx: RunnerContext, effect: JobEffect): Promise<void> {
    if (effect.kind === 'toast') {
        showToast(effect.tone, effect.message);
        return;
    }
    if (effect.kind === 'refresh') {
        const onRefresh = ctx.live.current.onRefresh;
        if (!onRefresh) return;
        await onRefresh(effect.tableId || effect.datasetId
            ? { tableId: effect.tableId || null, datasetId: effect.datasetId || null }
            : undefined);
    }
}

/** A job that ended: its vars, its deferred effects, the entry. */
async function finishJob(ctx: RunnerContext, actionId: string, view: JobView): Promise<void> {
    if (view.status === 'cancelled') {
        ctx.setEntry(actionId, { status: 'idle', result: undefined, error: null, jobId: view.jobId, progress: view.progress, cancelled: true });
        showToast('info', ctx.tr('studio_apps_durable.tray.cancelled', 'Cancelled'));
        return;
    }
    if (view.status === 'success') {
        for (const [name, value] of Object.entries(view.vars || {})) ctx.setVar(name, value);
        ctx.setEntry(actionId, { status: 'success', result: view.result ?? null, error: null, jobId: view.jobId, progress: view.progress });
        for (const effect of view.effects || []) await replayEffect(ctx, effect);
        return;
    }
    const message = view.error || (view.status === 'interrupted'
        ? ctx.tr('studio_apps_runtime.background.interrupted', 'The run was interrupted (the server restarted). Start it again.')
        : ctx.tr('studio_apps_runtime.actions.failed', 'The action failed.'));
    for (const [name, value] of Object.entries(view.vars || {})) ctx.setVar(name, value);
    ctx.setEntry(actionId, { status: 'error', result: undefined, error: message, jobId: view.jobId, progress: view.progress });
    showToast('danger', message);
}

type PollState = { failures: number; onHold: boolean };
/** What a caller of watchJob may ask for: `onHold` is called the first time the job is seen on hold. */
type WatchHooks = { awaited?: boolean; onHold?: () => void };

function stopWith(ctx: RunnerContext, actionId: string, jobId: string, message: string, tone: 'info' | null): 'done' {
    ctx.setEntry(actionId, { status: 'error', result: undefined, error: message, jobId });
    if (tone) showToast(tone, message);
    return 'done';
}

/** One look at the job: 'again' to keep polling, 'done' when it ended (or cannot be followed). */
async function pollOnce(ctx: RunnerContext, actionId: string, jobId: string, st: PollState, hooks: WatchHooks = {}): Promise<'again' | 'done'> {
    let res: Response;
    try {
        res = await getAuthed(jobsUrl(ctx.appId, jobId));
    } catch {
        st.failures += 1;
        if (st.failures < MAX_NETWORK_FAILURES) return 'again';
        return stopWith(ctx, actionId, jobId, ctx.tr('studio_apps_runtime.background.lost_track', 'Lost track of the run; it continues on the server.'), 'info');
    }
    st.failures = 0;
    if (!ctx.alive.current) return 'done';
    if (res.status === 404) return stopWith(ctx, actionId, jobId, ctx.tr('studio_apps_runtime.background.not_found', 'This run can no longer be found.'), null);
    const view = await readJson(res) as JobView | null;
    if (!res.ok || !view || typeof view.status !== 'string') return 'again';
    if (view.status === 'running') {
        st.onHold = false;
        ctx.setEntry(actionId, { status: 'running', result: undefined, error: null, jobId, progress: view.progress });
        return 'again';
    }
    if (view.status === 'paused') {
        const first = !st.onHold;
        st.onHold = true;
        ctx.setEntry(actionId, { status: 'running', result: undefined, error: null, jobId, progress: view.progress, waiting: { kind: view.waitKind ?? null, wakeAt: view.wakeAt ?? null } });
        if (first) hooks.onHold?.();
        return 'again';
    }
    await finishJob(ctx, actionId, view);
    return 'done';
}

/** How long to wait before look number `n` (0-based) at a job. */
function pollDelay(n: number, sinceStart: number, st: PollState, awaited: boolean): number {
    if (st.onHold) return POLL_ON_HOLD_MS;
    if (awaited && n < POLL_AWAITED_MS.length) return POLL_AWAITED_MS[n];
    return sinceStart > POLL_SLOW_AFTER_MS ? POLL_LATER_MS : POLL_FIRST_MS;
}

/** Follow job `jobId` of `actionId` until it ends (once per surface; silent once unmounted). */
async function watchJob(ctx: RunnerContext, actionId: string, jobId: string, hooks: WatchHooks = {}): Promise<void> {
    const jobs = ctx.jobs;
    if (jobs?.has(jobId)) return;
    jobs?.add(jobId);
    const started = backgroundTiming.now();
    const st: PollState = { failures: 0, onHold: false };
    try {
        for (let n = 0; ; n += 1) {
            await backgroundTiming.wait(pollDelay(n, backgroundTiming.now() - started, st, hooks.awaited === true));
            if (!ctx.alive.current) return;
            if ((await pollOnce(ctx, actionId, jobId, st, hooks)) === 'done') return;
        }
    } finally {
        jobs?.delete(jobId);
    }
}

/** The leading confirms and the editor's save; false when the run must not start. */
async function mayStart(ctx: RunnerContext, actionId: string, action: RunnableAction): Promise<boolean> {
    if (ctx.live.current.actionState[actionId]?.status === 'running') return false;
    if (!(await askConfirms(ctx, action))) return false;
    const beforeServerStep = ctx.live.current.beforeServerStep;
    if (!beforeServerStep) return true;
    const ready = await beforeServerStep();
    if (ready && ready.ok === false) {
        showToast('danger', ready.error || ctx.tr('studio_apps_runtime.actions.not_saved', 'Your latest changes could not be saved, so this was not run.'));
        return false;
    }
    return true;
}

/**
 * Follow the job. The promise settles when the job ended, or, for a click that waits for it
 * (`awaited`), as soon as the job is on hold: the run then goes on without the page.
 */
function follow(ctx: RunnerContext, actionId: string, jobId: string, awaited = false): Promise<void> {
    ctx.setEntry(actionId, { status: 'running', result: undefined, error: null, jobId, progress: null });
    if (!awaited) { void watchJob(ctx, actionId, jobId); return Promise.resolve(); }
    return new Promise<void>((resolve) => {
        const onHold = (): void => {
            showToast('info', ctx.tr('studio_apps_durable.tray.on_hold', 'This is waiting now and goes on by itself. You can close the page.'));
            resolve();
        };
        void watchJob(ctx, actionId, jobId, { awaited: true, onHold }).then(resolve, resolve);
    });
}

/** What the start answered: follow the job, or say why not. */
function onStartAnswer(ctx: RunnerContext, actionId: string, status: number, body: Record<string, unknown> | null, awaited = false): Promise<void> | void {
    const jobId = typeof body?.jobId === 'string' ? body.jobId : null;
    if (status === 202 && jobId) return follow(ctx, actionId, jobId, awaited);
    const message = (typeof body?.error === 'string' && body.error) || ctx.tr('studio_apps_runtime.background.start_failed', 'The run could not be started. Try again.');
    if (status === 409) {
        // Already running for the same item: this viewer's own run is followed, anyone else's is only named.
        showToast('info', message);
        if (jobId) return follow(ctx, actionId, jobId, awaited);
        ctx.setEntry(actionId, { status: 'idle', result: undefined, error: null });
        return;
    }
    ctx.setEntry(actionId, { status: 'error', result: undefined, error: message });
    showToast('danger', message);
}

/** Start the job of a background action. Resolves when the server accepted (or refused) it. */
export function runBackgroundAction(ctx: RunnerContext, actionId: string, action: RunnableAction, opts: RunOpts): Promise<void> {
    return startJob(ctx, actionId, action, opts, false);
}

/**
 * Run a sequence with `runOn: 'server'`: the same server job, but this resolves when the job has
 * ended (its result, variables and deferred effects are in by then), or is on hold.
 */
export function runServerAction(ctx: RunnerContext, actionId: string, action: RunnableAction, opts: RunOpts): Promise<void> {
    return startJob(ctx, actionId, action, opts, true);
}

async function startJob(ctx: RunnerContext, actionId: string, action: RunnableAction, opts: RunOpts, awaited: boolean): Promise<void> {
    if (!(await mayStart(ctx, actionId, action))) return;
    ctx.setEntry(actionId, { status: 'running', result: undefined, error: null, progress: null });
    let res: Response;
    try {
        res = await postJson(`${actionsUrl(ctx.appId)}/${encodeURIComponent(actionId)}/background${ctx.draft ? '?draft=1' : ''}`, startBody(ctx, opts));
    } catch {
        const message = ctx.tr('studio_apps_runtime.background.start_failed', 'The run could not be started. Try again.');
        ctx.setEntry(actionId, { status: 'error', result: undefined, error: message });
        showToast('danger', message);
        return;
    }
    await onStartAnswer(ctx, actionId, res.status, await readJson(res), awaited);
}

/** Pick up the viewer's running jobs (after a reload, from another tab). */
export function resumeActiveJobs(ctx: RunnerContext, jobs: JobView[]): void {
    for (const job of jobs) {
        if (!job || typeof job.jobId !== 'string' || (job.status !== 'running' && job.status !== 'paused') || ctx.jobs?.has(job.jobId)) continue;
        if (!ctx.live.current.definition?.actions?.[job.actionId]) continue;
        const waiting = job.status === 'paused' ? { kind: job.waitKind ?? null, wakeAt: job.wakeAt ?? null } : null;
        ctx.setEntry(job.actionId, { status: 'running', result: undefined, error: null, jobId: job.jobId, progress: job.progress, ...(waiting ? { waiting } : {}) });
        void watchJob(ctx, job.actionId, job.jobId);
    }
}
