/**
 * Continuing, waking and cancelling a server run (backgroundRun.mts re-exports these).
 *
 * A run that was on hold goes on in the actions its pause kept (backgroundRunDurable.mts, the
 * snapshot): publishing the app again with the action edited does not end a run that waits.
 * Who may continue, and with which data, is read fresh.
 *
 * resumeBackgroundRun continues a run that is on hold, on whichever instance is asked: for the
 * wake job, for server code that names what the run waits for, or for the holder of its resume
 * token. It checks who and what the run continues as (backgroundRunIdentity.mts), claims the
 * row with a compare-and-set (one resumer wins, the others read `already_resumed`) and walks on
 * from the paused step. cancelBackgroundRun ends a paused run at once and stops a running one
 * before its next step.
 */

import { resumedWalkState } from './sequenceWalk.mts';
import { ownAction } from './actionCalls.mts';
import { readPausedRecord, resumeOutcome, unknownStepKind } from './backgroundRunDurable.mts';
import type { PausedRecord, ResumeBy } from './backgroundRunDurable.mts';
import { resumeTokenMatches } from './runPause.mts';
import { isShuttingDown, launch, newJob, running } from './backgroundRunJob.mts';
import type { Job } from './backgroundRunJob.mts';
import { withDefaults } from './backgroundRunParts.mts';
import type { RunnerDeps, StartInput } from './backgroundRunParts.mts';
import { SERVER_RUN_ORIGINS } from '../stores/studioAppData/actionRuns.mts';
import type { ActionRunRow } from '../stores/studioAppData/actionRuns.mts';

export type ResumeResult =
    | { ok: true; jobId: string }
    | { ok: false; status: number; code: 'not_found' | 'not_paused' | 'already_resumed' | 'not_due' | 'token_invalid' | 'wait_mismatch' | 'resume_refused' | 'shutting_down'; error: string };

const notResumed = (status: number, code: Exclude<ResumeResult, { ok: true }>['code'], error: string): ResumeResult => ({ ok: false, status, code, error });
const NOT_FOUND = notResumed(404, 'not_found', 'Run not found');
const ALREADY = notResumed(409, 'already_resumed', 'This run was already resumed.');

/**
 * May `how` resume this paused row at all? The timer only once the wake time passed; server code
 * only for the wait it names; a token only in the hands of the starter or the owner, for the app
 * the request was gated on, and only when it is the row's token. Null: go on to the claim.
 */
async function resumeGate(row: ActionRunRow, how: ResumeBy, deps: RunnerDeps): Promise<ResumeResult | null> {
    if (how.by === 'timer') {
        const due = row.wakeAt ? Date.parse(row.wakeAt) : NaN;
        return Number.isFinite(due) && due <= deps.now() ? null : notResumed(409, 'not_due', 'This run is not due yet.');
    }
    if (how.by === 'system') {
        return row.waitKind === how.waitKind && row.waitRef === how.waitRef ? null : notResumed(409, 'wait_mismatch', 'This run does not wait for that.');
    }
    if (row.appId !== how.appId || (row.viewerUserId !== how.userId && row.ownerUserId !== how.userId)) return NOT_FOUND;
    const hash = await deps.store().resumeTokenHash(row.id);
    return resumeTokenMatches(how.token, hash) ? null : notResumed(403, 'token_invalid', 'This run cannot be resumed with that token.');
}

/** A job for a claimed row: the walk put back, the clock and the limits carried on from before the pause. */
function resumedJob(row: ActionRunRow, record: PausedRecord, how: ResumeBy, input: StartInput, deps: RunnerDeps): Job | null {
    const w = resumedWalkState(record.walk, resumeOutcome(how, record));
    // The run goes on in the actions its pause kept, not in the definition as it is now.
    const action = ownAction(record.actions, input.actionId);
    if (!w || !action) return null;
    const limits = deps.limits();
    const job = newJob(row.id, input, action, deps, limits);
    const left = limits.maxRunMs ? Math.max(0, limits.maxRunMs - record.run.activeMs) : 0;
    return {
        ...job, w, actions: record.actions, deadline: limits.maxRunMs ? job.startedAt + left : 0, activeMs: record.run.activeMs, written: record.run.written,
        seenEffects: new Set(w.deferred.map((effect) => JSON.stringify(effect))),
        progress: { ...job.progress, executed: w.executed, message: typeof row.progress.message === 'string' ? row.progress.message : null },
    };
}

/**
 * Continue a paused run. Exactly one caller wins the row (a compare-and-set on its resume
 * counter); every other one is answered `already_resumed` and nothing runs twice.
 *
 * Before the claim, and read fresh from the database: who and what the run continues as
 * (backgroundRunIdentity.mts). A run that may not go on is ended as `refused` by the caller that
 * wins the row. A failure of that read touches nothing: the run stays on hold for the next try.
 */
export async function resumeBackgroundRun(runId: string, how: ResumeBy, given: Partial<RunnerDeps> = {}): Promise<ResumeResult> {
    const deps = withDefaults(given);
    if (isShuttingDown()) return notResumed(503, 'shutting_down', 'The server is restarting. Try again in a minute.');
    const store = deps.store();
    const row = await store.getRunById(runId);
    if (!row || !SERVER_RUN_ORIGINS.includes(row.origin) || (how.by === 'token' && row.appId !== how.appId)) return NOT_FOUND;
    if (row.status !== 'paused') return row.status === 'running' ? ALREADY : notResumed(409, 'not_paused', 'This run is not on hold.');
    const gated = await resumeGate(row, how, deps);
    if (gated) return gated;
    const peek = await store.pausedStateOf(row.id, row.resumeSeq);
    if (!peek) return ALREADY;
    const before = readPausedRecord(peek);
    const ctx = before ? unknownKindRefusal(before) ?? await deps.loadResumeContext(row, before.run) : null;
    const claimed = await store.claimResume(row.id, row.resumeSeq, deps.instanceId);
    if (!claimed) return ALREADY;
    // From here the row is `running` and this process owns it.
    const record = readPausedRecord(claimed.state);
    const job = ctx?.ok && record ? resumedJob(claimed.row, record, how, ctx.input, deps) : null;
    if (!job) return endUnresumed(row, ctx && !ctx.ok ? ctx : null, record, deps);
    launch(job);
    return { ok: true, jobId: row.id };
}

/** A snapshot that holds a step kind this install does not know cannot be walked: the run ends as refused. */
function unknownKindRefusal(record: PausedRecord): { ok: false; code: string; error: string } | null {
    const kind = unknownStepKind(record.actions);
    return kind ? { ok: false, code: 'step_kind_unknown', error: 'This run waited in a step this version of the app builder does not have, so the run was ended.' } : null;
}

/** The claimed row of a run that does not go on: `refused` when the identity check said no, an error when its state is unreadable. */
async function endUnresumed(row: ActionRunRow, refused: { code: string; error: string } | null, record: PausedRecord | null, deps: RunnerDeps): Promise<ResumeResult> {
    const why = refused ?? { code: 'resume_lost', error: 'The run could not continue where it paused.' };
    await deps.store().finishRun(row.id, {
        status: refused ? 'refused' : 'error', error: why.error, errorCode: why.code, durationMs: record ? record.run.activeMs : null,
        stepCount: row.stepCount, truncated: true, endedBy: 'resume',
    });
    deps.log.info(`[StudioBackground] ${row.id} app=${row.appId} action=${row.actionId} not resumed (${why.code})`);
    return notResumed(409, 'resume_refused', why.error);
}

/** Server code continues every run that waits for (kind, ref), each with `payload` as its step's result. */
export async function resumeWaiting(waitKind: string, waitRef: string, payload: unknown, given: Partial<RunnerDeps> = {}): Promise<ResumeResult[]> {
    const rows = await withDefaults(given).store().findPausedByWait(waitKind, waitRef);
    const out: ResumeResult[] = [];
    for (const row of rows) out.push(await resumeBackgroundRun(row.id, { by: 'system', waitKind, waitRef, payload }, given));
    return out;
}

/** One pass of the wake job: every paused run whose wake time passed is continued (or ended, when it may not go on). */
export async function wakeDueRuns(given: Partial<RunnerDeps> = {}): Promise<{ due: number; resumed: number }> {
    const deps = withDefaults(given);
    const rows = isShuttingDown() ? [] : await deps.store().listDueWakes(deps.limits().wakeBatch);
    let resumed = 0;
    for (const row of rows) {
        try {
            if ((await resumeBackgroundRun(row.id, { by: 'timer' }, given)).ok) resumed += 1;
        } catch (e) {
            deps.log.warn(`[StudioBackground] ${row.id} app=${row.appId} could not be woken (${(e as Error)?.name || 'error'}); it stays on hold`);
        }
    }
    return { due: rows.length, resumed };
}

/**
 * Cancel a run of app `appId` (the caller has authorised the app and that this person may act on
 * the run). A paused run ends `cancelled` there and then and never resumes; a running one stops
 * before its next step. Null: no such run, or it already ended.
 */
export async function cancelBackgroundRun(appId: string, jobId: string, given: Partial<RunnerDeps> = {}): Promise<'cancelled' | 'cancelling' | null> {
    const deps = withDefaults(given);
    const status = await deps.store().requestCancel(appId, jobId);
    if (status === 'running') {
        const job = running.get(jobId);
        if (job) job.cancelled = true;
        return 'cancelling';
    }
    if (status === 'cancelled') deps.log.info(`[StudioBackground] ${jobId} app=${appId} cancelled while on hold`);
    return status;
}
